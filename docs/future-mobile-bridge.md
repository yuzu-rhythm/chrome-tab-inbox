# 将来のモバイル共有ブリッジ

この文書は、Androidの任意アプリから共有できるShare Targetと、将来のiPhone Shortcuts / Share Extensionを、Mac Chromeの「まだやっていない」へつなぐための設計メモです。v1ではリモートキュー、Androidアプリ、iPhoneアプリ、外部認証を実装しません。v1の実装はChrome Reading Listを入力元にする `ReadingListInboxSource` だけです。

## v1から交換可能にしている境界

```text
Android Share Target / iPhone Share Extension / Shortcuts
                 ↓
          OS-neutral Remote Queue
                 ↓
     Mac Chrome extension (pull + ack)
                 ↓
           InboxSource
                 ↓
       「まだやっていない」tab group
```

Coreは、入力元を次の正規化済みレコードとして扱います。`groupId`、Chromeのwindow ID、ユーザーの端末内IDはプロトコルへ持ち込みません。

```json
{
  "id": "stable-source-id",
  "url": "https://example.com/article?view=full",
  "title": "Example article",
  "createdAt": "2026-08-26T09:42:00.000Z",
  "device": "iphone",
  "source": "future-remote"
}
```

実装する場合の最小プロトコル案は次のとおりです。

* `POST /v1/inbox` — URL、任意のタイトル、作成時刻、端末名を受け付ける。サーバー側でURLのhttp(s)検証とサイズ制限を行う。
* `GET /v1/inbox?cursor=...` — 未確認の項目をページングして返す。`id`は再取得しても変わらない値にする。
* `POST /v1/inbox/{id}/ack` — Macがタブを作成し、グループ化し、バッジ更新を確認した後だけ呼ぶ。ACK前に項目を消さない。
* `GET /v1/health` — 認証情報を返さない、軽量な疎通確認。

キューは少なくとも「pending」「acknowledged」の状態を持ち、同じ `id` の再送を冪等に扱います。Macがスリープ中でもモバイルから追加でき、Macが起きたときのpull失敗やACK失敗ではpendingを残します。リモート側の保存期限を設ける場合も、期限切れで黙って消さず、クライアントへ明示できるようにします。

## バックエンド候補の比較

| 候補 | 無料・低コスト面 | 良い点 | 注意点 | この用途との相性 |
| --- | --- | --- | --- | --- |
| Cloudflare Worker + KV / D1 | 2026-08-26時点のWorkers Freeは1日10万request、KVは1日10万read・1,000 write、D1は1日500万row read・10万row writeの無料枠がある。個人キューには十分大きい。 | WorkerのHTTP endpointが小さく、D1はSQLite互換の永続データとACKのトランザクションを扱いやすい。アクセス制御とレート制限も同じ場所に置ける。 | KVは強い一貫性や複雑なpending一覧に向かない。D1を使うならスキーマ、マイグレーション、認証トークンの管理が必要。 | 高い。Worker + D1を基本にし、KVは短い設定値やレート制限用に限定するのが分かりやすい。 |
| Firebase | Spark planは支払い方法なしで開始でき、Firestoreは1 GiB、1日5万read・2万writeの無料枠がある。 | Firestoreのオフライン対応、Firebase Authentication、Android/iOS SDKが充実している。モバイルアプリの認証を後から広げやすい。 | セキュリティルール、SDK、必要に応じたFunctions、課金境界が増えやすい。個人用の小さなpull/ACKだけなら運用面がやや重い。 | 中。すでにFirebaseを使う場合、またはネイティブアプリでオフライン書き込みを最優先する場合に有力。 |
| Supabase | Freeは2 active project、DB 500 MBなどの枠がある。ただし低活動のFree projectは約1週間でpause対象になる。 | Postgres、Row Level Security、Auth、Edge Functionsをまとめて利用できる。SQLでpending/ACKや監査ログを明確にできる。 | pauseからの復帰と、Auth・RLS・Edge Function・公開キー境界の継続管理が必要。常時受信したい個人Inboxではpauseが摩擦になる。 | 中。Postgresを活用したい場合は強いが、低メンテナンス最優先ならWorkerより部品が多い。 |

価格、無料枠、リージョン、認証機能、利用規約は変わるため、導入時に各公式料金・仕様を再確認します。ここでの評価は、数件〜数百件程度の個人キューを想定した設計上の比較です。現時点の根拠は、[Cloudflare Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)、[Firebase料金](https://firebase.google.com/pricing)、[Firestore料金](https://firebase.google.com/docs/firestore/pricing)、[Supabase料金](https://supabase.com/pricing)、[Supabase Free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)です。

## 推奨方向

第一候補は **Cloudflare Worker + D1** です。理由は、HTTP APIを一つの小さなWorkerに収められ、D1でpending取得とACKを扱いやすく、モバイル・Mac双方からOSに依存しないHTTPSプロトコルで接続できるためです。KVだけでキューを表現するのは、一覧取得と同時更新の整合性を説明しにくいので推奨しません。

認証は、最初から公開書き込みendpointにせず、長いランダムな個人トークンをHTTPSのBearer tokenとして使い、Worker側でハッシュ化した検証値とレート制限を持たせます。トークンをGit、スクリーンショット、URLクエリへ出さず、Chrome拡張へ埋め込む場合のリスクも理解したうえで、可能ならOSの安全な保管領域から渡します。個人用途でも、URLとタイトルは閲覧履歴に近い情報として扱い、ログへ本文やトークンを出しません。

将来、複数ユーザー、チーム共有、強いアカウント管理、複雑な検索が必要になったらSupabaseまたはFirebaseを再評価します。v1の `RemoteQueueInboxSource` はこの方針の候補であり、ネットワーク呼び出しや認証情報を持たない空の拡張点です。
