import 'dart:convert';

/// Anything the client throws.
sealed class KitsudenException implements Exception {
  const KitsudenException();
}

/// An `/api/*` error. Every one is `application/problem+json` (RFC 9457) with a
/// stable [code] (`KITSUDEN_E_*`): branch on it, never on the message. [retryable]
/// says whether the SAME request may succeed if repeated; [retryAfter] how many
/// seconds to wait first.
final class KitsudenApiException extends KitsudenException {
  final int status;
  final String code;
  final String? title;
  final String? detail;
  final String? hint;
  final bool retryable;
  final double? retryAfter;
  final String? requestId;

  const KitsudenApiException({
    required this.status,
    required this.code,
    this.title,
    this.detail,
    this.hint,
    required this.retryable,
    this.retryAfter,
    this.requestId,
  });

  /// Retryable even without a problem body (a proxy's error page).
  static const retryableStatuses = {408, 429, 502, 503, 504};

  factory KitsudenApiException.fromResponse(int status, String body, String? retryAfterHeader) {
    final headerWait = retryAfterHeader == null ? null : double.tryParse(retryAfterHeader.trim());
    Map<String, dynamic>? problem;
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic>) problem = decoded;
    } catch (_) {}
    String? text(String key) {
      final v = problem?[key];
      return v is String ? v : null;
    }

    final retryable = problem?['retryable'];
    final retryAfter = problem?['retry_after'];
    return KitsudenApiException(
      status: status,
      code: text('code') ?? fallbackCode(status),
      title: text('title'),
      detail: text('detail') ?? text('error'),
      hint: text('hint'),
      retryable: retryable is bool ? retryable : retryableStatuses.contains(status),
      retryAfter: retryAfter is num ? retryAfter.toDouble() : headerWait,
      requestId: text('requestId'),
    );
  }

  static String fallbackCode(int status) => switch (status) {
        400 => 'KITSUDEN_E_BAD_REQUEST',
        401 => 'KITSUDEN_E_UNAUTHENTICATED',
        403 => 'KITSUDEN_E_FORBIDDEN',
        404 => 'KITSUDEN_E_NOT_FOUND',
        409 => 'KITSUDEN_E_CONFLICT',
        413 => 'KITSUDEN_E_PAYLOAD_TOO_LARGE',
        422 => 'KITSUDEN_E_VALIDATION',
        429 => 'KITSUDEN_E_RATE_LIMITED',
        502 => 'KITSUDEN_E_BAD_GATEWAY',
        503 => 'KITSUDEN_E_UNAVAILABLE',
        504 => 'KITSUDEN_E_TIMEOUT',
        _ => 'KITSUDEN_E_INTERNAL',
      };

  @override
  String toString() {
    final b = StringBuffer('$code (HTTP $status)');
    if (detail != null) b.write(': $detail');
    if (hint != null) b.write(' — $hint');
    return b.toString();
  }
}

/// No HTTP response (offline, DNS, timeout).
final class KitsudenNetworkException extends KitsudenException {
  final Object cause;
  const KitsudenNetworkException(this.cause);
  @override
  String toString() => 'KitsudenNetworkException: $cause';
}

/// A success body that is not the JSON the operation promises.
final class KitsudenDecodeException extends KitsudenException {
  final String message;
  const KitsudenDecodeException(this.message);
  @override
  String toString() => 'KitsudenDecodeException: $message';
}
