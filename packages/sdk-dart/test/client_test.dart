import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:kitsuden/kitsuden.dart';
import 'package:test/test.dart';

const entry = '{"id":"e1","dataSetId":"d1","title":"Hello","data":{"score":3},"status":"published",'
    '"sortOrder":1,"ownerId":null,"createdAt":"2026-11-04T00:00:00Z","updatedAt":"2026-11-04T00:00:00Z"}';

/// Answers with canned responses and records the requests: no network.
(KitsudenClient, List<http.Request>) clientWith(
  List<http.Response> responses, {
  Credentials credentials = const NoCredentials(),
}) {
  final seen = <http.Request>[];
  final queue = [...responses];
  final mock = MockClient((request) async {
    seen.add(request);
    return queue.isEmpty ? http.Response('', 500) : queue.removeAt(0);
  });
  return (
    KitsudenClient(Uri.parse('https://api.example.com/'), credentials: credentials, httpClient: mock),
    seen,
  );
}

void main() {
  test('agent key goes in Authorization and lists decode', () async {
    final (client, seen) = clientWith([http.Response('{"docs":[$entry]}', 200)],
        credentials: const AgentKey('kitsuden_agent_x'));

    final entries = await client.listEntries('d1', limit: 10);

    expect(entries, hasLength(1));
    expect(entries.first.data['score'], 3);
    expect(seen.first.method, 'GET');
    expect(seen.first.url.toString(), 'https://api.example.com/api/datasets/d1/entries?limit=10');
    expect(seen.first.headers['Authorization'], 'Bearer kitsuden_agent_x');
    expect(seen.first.headers.containsKey('Idempotency-Key'), isFalse, reason: 'reads carry no key');
  });

  test('a session token goes in the cookie', () async {
    final (client, seen) = clientWith([http.Response('{"docs":[]}', 200)],
        credentials: const SessionToken('tok', cookieName: '__Secure-better-auth.session_token'));
    await client.listDatasets();
    expect(seen.first.headers['Cookie'], '__Secure-better-auth.session_token=tok');
    expect(seen.first.headers.containsKey('Authorization'), isFalse);
  });

  test('writes carry an Idempotency-Key and a JSON body', () async {
    final (client, seen) = clientWith([http.Response(entry, 201), http.Response(entry, 200)],
        credentials: const AgentKey('k'));

    final created = await client.createEntry('d1', const EntryInput(title: 'Hello', data: {'score': 3}));
    expect(created.valueOrNull?.id, 'e1');
    expect(seen[0].method, 'POST');
    expect(seen[0].headers['Idempotency-Key'], matches(RegExp(r'^[0-9a-f-]{36}$')));
    final sent = jsonDecode(seen[0].body) as Map<String, dynamic>;
    expect(sent['title'], 'Hello');
    expect(sent.containsKey('status'), isFalse, reason: 'nulls are not sent');

    await client.updateEntry('d1', 'e1', const EntryInput(title: 'Bye'), idempotencyKey: 'retry-key-0001');
    expect(seen[1].method, 'PATCH');
    expect(seen[1].headers['Idempotency-Key'], 'retry-key-0001');
  });

  test('problem+json becomes a typed error', () async {
    const problem = '{"title":"Rate limited","status":429,"code":"KITSUDEN_E_RATE_LIMITED","detail":"Too many",'
        '"retryable":true,"retry_after":7,"hint":"Wait","requestId":"r1"}';
    final (client, _) = clientWith([http.Response(problem, 429)]);
    await expectLater(
      client.getDataset('d1'),
      throwsA(isA<KitsudenApiException>()
          .having((e) => e.code, 'code', 'KITSUDEN_E_RATE_LIMITED')
          .having((e) => e.status, 'status', 429)
          .having((e) => e.retryable, 'retryable', isTrue)
          .having((e) => e.retryAfter, 'retryAfter', 7)
          .having((e) => e.requestId, 'requestId', 'r1')),
    );
  });

  test('a non-problem error still gets a catalog code', () async {
    final (client, _) = clientWith([http.Response('<html>bad gateway</html>', 503, headers: {'retry-after': '5'})]);
    await expectLater(
      client.listDatasets(),
      throwsA(isA<KitsudenApiException>()
          .having((e) => e.code, 'code', 'KITSUDEN_E_UNAVAILABLE')
          .having((e) => e.retryable, 'retryable', isTrue)
          .having((e) => e.retryAfter, 'retryAfter', 5)),
    );
  });

  test('a 202 proposal is returned, not thrown', () async {
    const body = '{"code":"KITSUDEN_E_APPROVAL_REQUIRED","status":202,'
        '"proposal":{"id":"p1","status":"pending","statusUrl":"/api/agents/proposals/p1"}}';
    final (client, seen) = clientWith([http.Response(body, 202)], credentials: const AgentKey('k'));
    final result = await client.deleteEntry('d1', 'e1');
    expect(result, isA<PendingApproval<bool>>());
    expect((result as PendingApproval<bool>).proposal.id, 'p1');
    expect(seen.first.method, 'DELETE');
    expect(seen.first.headers.containsKey('Idempotency-Key'), isTrue);
  });

  test('ids are escaped in the path', () async {
    final (client, seen) = clientWith([http.Response(entry, 200)]);
    await client.getEntry('a/b', 'e 1');
    expect(seen.first.url.toString(), 'https://api.example.com/api/datasets/a%2Fb/entries/e%201');
  });
}
