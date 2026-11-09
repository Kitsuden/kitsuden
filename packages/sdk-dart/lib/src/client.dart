import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'errors.dart';
import 'models.dart';

/// How the client authenticates.
sealed class Credentials {
  const Credentials();
}

/// An agent key (`kitsuden_agent_…`), sent as `Authorization: Bearer`.
final class AgentKey extends Credentials {
  final String key;
  const AgentKey(this.key);
}

/// A signed-in user's better-auth session token, sent as a cookie. Behind HTTPS in
/// production the cookie is called `__Secure-better-auth.session_token`.
final class SessionToken extends Credentials {
  final String token;
  final String cookieName;
  const SessionToken(this.token, {this.cookieName = 'better-auth.session_token'});
}

/// Public reads only.
final class NoCredentials extends Credentials {
  const NoCredentials();
}

/// A minimal Kitsuden client: datasets and their entries.
///
/// ```dart
/// final kitsuden = KitsudenClient(Uri.parse('https://api.example.com'), credentials: AgentKey(key));
/// final entries = await kitsuden.listEntries(datasetId);
/// ```
///
/// Every write carries an `Idempotency-Key` (a new random one unless you pass one):
/// if the network drops after the server acted, sending the SAME call again with the
/// same key returns the first result instead of acting twice.
class KitsudenClient {
  final Uri baseUrl;
  final Credentials credentials;
  final http.Client _http;

  /// [httpClient] defaults to a new `http.Client`; tests pass a `MockClient`.
  KitsudenClient(this.baseUrl, {this.credentials = const NoCredentials(), http.Client? httpClient})
      : _http = httpClient ?? http.Client();

  void close() => _http.close();

  // ── Datasets ────────────────────────────────────────────────────────────

  /// The datasets this caller can read (1-200, default 50).
  Future<List<Dataset>> listDatasets({int? limit}) async =>
      _docs(await _read('datasets', {if (limit != null) 'limit': '$limit'})).map(Dataset.fromJson).toList();

  Future<Dataset> getDataset(String id) async => Dataset.fromJson(await _read('datasets/${_seg(id)}'));

  // ── Entries ─────────────────────────────────────────────────────────────

  /// Entries in their order (1-1000, default 500), filtered by the dataset's rules.
  Future<List<Entry>> listEntries(String datasetId, {int? limit}) async =>
      _docs(await _read('datasets/${_seg(datasetId)}/entries', {if (limit != null) 'limit': '$limit'}))
          .map(Entry.fromJson)
          .toList();

  Future<Entry> getEntry(String datasetId, String entryId) async =>
      Entry.fromJson(await _read('datasets/${_seg(datasetId)}/entries/${_seg(entryId)}'));

  Future<WriteResult<Entry>> createEntry(String datasetId, EntryInput input, {String? idempotencyKey}) =>
      _write('POST', 'datasets/${_seg(datasetId)}/entries', input.toJson(), idempotencyKey, Entry.fromJson);

  Future<WriteResult<Entry>> updateEntry(String datasetId, String entryId, EntryInput input,
          {String? idempotencyKey}) =>
      _write('PATCH', 'datasets/${_seg(datasetId)}/entries/${_seg(entryId)}', input.toJson(), idempotencyKey,
          Entry.fromJson);

  /// `Done(true)` when deleted.
  Future<WriteResult<bool>> deleteEntry(String datasetId, String entryId, {String? idempotencyKey}) =>
      _write('DELETE', 'datasets/${_seg(datasetId)}/entries/${_seg(entryId)}', null, idempotencyKey, (_) => true);

  // ── Plumbing ────────────────────────────────────────────────────────────

  /// One path segment, escaped (a `/` in an id must not become a path).
  String _seg(String value) => Uri.encodeComponent(value);

  Uri _url(String path, [Map<String, String> query = const {}]) {
    var base = baseUrl.toString();
    while (base.endsWith('/')) {
      base = base.substring(0, base.length - 1);
    }
    final url = Uri.parse('$base/api/$path');
    return query.isEmpty ? url : url.replace(queryParameters: query);
  }

  Map<String, String> _headers() => {
        'Accept': 'application/json',
        ...switch (credentials) {
          AgentKey(:final key) => {'Authorization': 'Bearer $key'},
          SessionToken(:final token, :final cookieName) => {'Cookie': '$cookieName=$token'},
          NoCredentials() => <String, String>{},
        },
      };

  Future<http.Response> _send(http.Request request) async {
    try {
      return await http.Response.fromStream(await _http.send(request));
    } on http.ClientException catch (e) {
      throw KitsudenNetworkException(e);
    }
  }

  void _check(http.Response response) {
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw KitsudenApiException.fromResponse(response.statusCode, response.body, response.headers['retry-after']);
    }
  }

  Object? _parse(String body) {
    try {
      return jsonDecode(body);
    } on FormatException {
      throw const KitsudenDecodeException('response is not JSON');
    }
  }

  List<Object?> _docs(Object? json) {
    if (json is Map<String, dynamic> && json['docs'] is List) return json['docs'] as List<Object?>;
    throw const KitsudenDecodeException('response without docs');
  }

  Future<Object?> _read(String path, [Map<String, String> query = const {}]) async {
    final request = http.Request('GET', _url(path, query))..headers.addAll(_headers());
    final response = await _send(request);
    _check(response);
    return _parse(response.body);
  }

  Future<WriteResult<T>> _write<T>(
    String method,
    String path,
    Map<String, dynamic>? body,
    String? idempotencyKey,
    T Function(Object?) decode,
  ) async {
    final request = http.Request(method, _url(path))
      ..headers.addAll(_headers())
      ..headers['Idempotency-Key'] = idempotencyKey ?? _uuid();
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    final response = await _send(request);
    if (response.statusCode == 202) {
      final proposal = _pendingProposal(response.body);
      if (proposal != null) return PendingApproval<T>(proposal);
    }
    _check(response);
    return Done<T>(decode(_parse(response.body)));
  }

  /// A 202 is a pending proposal only when its `code` says so.
  Proposal? _pendingProposal(String body) {
    Object? json;
    try {
      json = jsonDecode(body);
    } catch (_) {
      return null;
    }
    if (json is! Map<String, dynamic> || json['code'] != 'KITSUDEN_E_APPROVAL_REQUIRED') return null;
    final p = json['proposal'];
    if (p is! Map<String, dynamic> || p['id'] is! String || p['statusUrl'] is! String) return null;
    return Proposal(
      id: p['id'] as String,
      status: p['status'] is String ? p['status'] as String : 'pending',
      statusUrl: p['statusUrl'] as String,
      reason: p['reason'] is String ? p['reason'] as String : null,
    );
  }

  static final _random = Random.secure();

  /// A random (version 4) UUID, without a dependency.
  static String _uuid() {
    final b = List<int>.generate(16, (_) => _random.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
    return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
  }
}
