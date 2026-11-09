import 'errors.dart';

String? _str(Map<String, dynamic> j, String key) {
  final v = j[key];
  return v is String ? v : null;
}

Map<String, dynamic> _obj(Object? json) {
  if (json is Map<String, dynamic>) return json;
  throw const KitsudenDecodeException('expected a JSON object');
}

/// A dataset (a typed collection). [schema] is its field definition, as JSON.
class Dataset {
  final String id;
  final String name;
  final String slug;
  final String? description;
  final Object? schema;
  final String? createdAt;
  final String? updatedAt;

  const Dataset({
    required this.id,
    required this.name,
    required this.slug,
    this.description,
    this.schema,
    this.createdAt,
    this.updatedAt,
  });

  factory Dataset.fromJson(Object? json) {
    final j = _obj(json);
    final id = _str(j, 'id');
    if (id == null) throw const KitsudenDecodeException('dataset without id');
    return Dataset(
      id: id,
      name: _str(j, 'name') ?? '',
      slug: _str(j, 'slug') ?? '',
      description: _str(j, 'description'),
      schema: j['schema'],
      createdAt: _str(j, 'createdAt'),
      updatedAt: _str(j, 'updatedAt'),
    );
  }
}

/// One entry of a dataset. [data] holds the fields the dataset schema defines.
class Entry {
  final String id;
  final String dataSetId;
  final String? title;
  final Map<String, dynamic> data;
  final String? status;
  final double? sortOrder;
  final String? ownerId;
  final String? createdAt;
  final String? updatedAt;

  const Entry({
    required this.id,
    required this.dataSetId,
    this.title,
    required this.data,
    this.status,
    this.sortOrder,
    this.ownerId,
    this.createdAt,
    this.updatedAt,
  });

  factory Entry.fromJson(Object? json) {
    final j = _obj(json);
    final id = _str(j, 'id');
    if (id == null) throw const KitsudenDecodeException('entry without id');
    final data = j['data'];
    final sortOrder = j['sortOrder'];
    return Entry(
      id: id,
      dataSetId: _str(j, 'dataSetId') ?? '',
      title: _str(j, 'title'),
      data: data is Map<String, dynamic> ? data : <String, dynamic>{},
      status: _str(j, 'status'),
      sortOrder: sortOrder is num ? sortOrder.toDouble() : null,
      ownerId: _str(j, 'ownerId'),
      createdAt: _str(j, 'createdAt'),
      updatedAt: _str(j, 'updatedAt'),
    );
  }
}

/// The body of an entry write. [title] and [data] are for everyone; [status] and
/// [sortOrder] are staff-only and are rejected for other callers. Nulls are not sent.
class EntryInput {
  final String? title;
  final Map<String, dynamic>? data;
  final String? status;
  final double? sortOrder;

  const EntryInput({this.title, this.data, this.status, this.sortOrder});

  Map<String, dynamic> toJson() => {
        if (title != null) 'title': title,
        if (data != null) 'data': data,
        if (status != null) 'status': status,
        if (sortOrder != null) 'sortOrder': sortOrder,
      };
}

/// A request held for human approval (HTTP 202, `KITSUDEN_E_APPROVAL_REQUIRED`).
/// Nothing ran. Do not resend it: poll [statusUrl] with the same credentials.
class Proposal {
  final String id;
  final String status;
  final String statusUrl;
  final String? reason;
  const Proposal({required this.id, required this.status, required this.statusUrl, this.reason});
}

/// What a write returns: done, or held for human approval.
sealed class WriteResult<T> {
  const WriteResult();

  /// The value, or null when the write waits for approval.
  T? get valueOrNull => switch (this) {
        Done<T>(:final value) => value,
        PendingApproval<T>() => null,
      };
}

final class Done<T> extends WriteResult<T> {
  final T value;
  const Done(this.value);
}

final class PendingApproval<T> extends WriteResult<T> {
  final Proposal proposal;
  const PendingApproval(this.proposal);
}
