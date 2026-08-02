# プライバシーポリシー / Privacy Policy

**最終更新 / Last updated: 2026-08-03**

---

## 日本語

### 要約

この拡張機能は、**あなたのデータを収集しません。開発者を含む第三者へ送信しません。**
サーバーを持たず、すべての処理と保存はあなたのブラウザ内で完結します。

さらに、Google Chat API へのアクセスには**あなた自身が用意した Google Cloud
プロジェクトと OAuth クライアント ID** を使います。開発者の認証情報は一切含まれておらず、
あなたの通信が開発者のプロジェクトを経由することはありません。

### 取り扱う情報

拡張機能の動作のために、以下をあなたのブラウザ内で取得・保存します。

| 情報 | 用途 | 保存場所 |
| --- | --- | --- |
| Google Chat のスペース／DM の一覧 | 監視対象を決めるため | `chrome.storage.local` |
| Google Chat のメッセージ（本文・送信者・時刻・メンション情報） | メンション検知、未読件数の算出、一覧表示のため | `chrome.storage.local` |
| 既読状態（`lastReadTime`） | 未読件数を算出するため | `chrome.storage.local` |
| あなたの Google ユーザー ID・表示名・メールアドレス | 「自分宛のメンションかどうか」を判定するため | `chrome.storage.local` |
| OAuth アクセストークン／リフレッシュトークン | Chat API を呼び出すため | `chrome.storage.local` |
| OAuth クライアント ID／シークレット | 認証のため | `chrome.storage.sync` |
| 設定（キーワード、通知設定、ミュートしたスペース等） | 動作の制御のため | `chrome.storage.sync` |

`chrome.storage.sync` に保存した項目は、あなたが Chrome の同期を有効にしている場合、
**Google のアカウント同期機能によってあなた自身の端末間で同期されます**。
これは Chrome の標準機能であり、開発者はその内容にアクセスできません。

### 送信先

拡張機能が通信する相手は、以下の Google のエンドポイントのみです。

- `https://chat.googleapis.com` — Google Chat API
- `https://www.googleapis.com` — ユーザー情報の取得
- `https://accounts.google.com`, `https://oauth2.googleapis.com` — OAuth 認証

**開発者のサーバーは存在しません。** 解析ツール、広告、トラッキングは一切組み込んでいません。

### 保存期間と削除

- メンションは最大 300 件、保存済みは最大 1000 件を保持し、古いものから自動的に破棄します
- サイドパネルの「この一覧を空に」でいつでも削除できます
- 設定画面の「接続を解除」で、保存したトークンを削除し、Google 側の認可も取り消します
- 拡張機能をアンインストールすると、保存されたデータはすべて削除されます

### 権限を必要とする理由

| 権限 | 理由 |
| --- | --- |
| `identity` | あなたの Google アカウントで OAuth 認証を行うため |
| `storage` | 設定・トークン・取得したメッセージをローカルに保存するため |
| `alarms` | 定期的に新着を確認するため |
| `notifications` | メンションをデスクトップ通知で知らせるため |
| `offscreen` | 通知音を鳴らすため（Service Worker では音を再生できないため） |
| `sidePanel` | メンション・未読・保存済みの一覧を表示するため |
| `tabs` | 通知や一覧から、既に開いている Google Chat のタブを再利用して開くため |
| `chat.google.com` / `mail.google.com` への権限 | メッセージ上に「★保存」ボタンを表示し、新着を素早く検知するため |
| `chat.googleapis.com` ほかへの権限 | Google Chat API と OAuth エンドポイントを呼び出すため |

### 要求する Google API のスコープ

| スコープ | 用途 |
| --- | --- |
| `chat.spaces.readonly` | 参加しているスペース／DM の一覧を取得 |
| `chat.messages.readonly` | メッセージ本文とメンション情報を取得 |
| `chat.users.readstate` | 既読状態の取得（設定を有効にした場合のみ更新） |
| `openid` / `userinfo.profile` | 自分宛のメンションかどうかを判定 |

これらのスコープで取得した情報は、上記の機能の提供以外の目的には使用しません。
Google API Services User Data Policy（Limited Use 要件を含む）に準拠します。

### お問い合わせ

不具合や本ポリシーに関するご質問は、GitHub の Issue でご連絡ください。
https://github.com/keisuke-kimura/google-chat-chrome-extension/issues

---

## English

### Summary

This extension **does not collect your data and does not transmit it to the developer or
any third party.** There is no backend server; all processing and storage happen locally
in your browser.

Access to the Google Chat API uses **an OAuth client ID from a Google Cloud project that
you create yourself.** The extension ships with no developer credentials, and none of your
traffic passes through any project controlled by the developer.

### Data handled

The extension retrieves and stores the following locally in your browser:

| Data | Purpose | Stored in |
| --- | --- | --- |
| List of Google Chat spaces and DMs | To determine what to monitor | `chrome.storage.local` |
| Chat messages (text, sender, timestamp, mention annotations) | Mention detection, unread counts, list display | `chrome.storage.local` |
| Read state (`lastReadTime`) | To compute unread counts | `chrome.storage.local` |
| Your Google user ID, display name, email | To determine whether a mention targets you | `chrome.storage.local` |
| OAuth access and refresh tokens | To call the Chat API | `chrome.storage.local` |
| OAuth client ID and secret | For authentication | `chrome.storage.sync` |
| Settings (keywords, notification options, muted spaces) | To control behavior | `chrome.storage.sync` |

Items in `chrome.storage.sync` are synchronized **across your own devices by Chrome's
built-in account sync** if you have sync enabled. This is a standard Chrome feature; the
developer has no access to that content.

### Network destinations

The extension communicates only with the following Google endpoints:

- `https://chat.googleapis.com` — Google Chat API
- `https://www.googleapis.com` — user profile lookup
- `https://accounts.google.com`, `https://oauth2.googleapis.com` — OAuth

**There is no developer-operated server.** No analytics, advertising, or tracking of any
kind is included.

### Retention and deletion

- Up to 300 mentions and 1000 saved items are retained; older entries are discarded automatically
- You can delete all entries at any time from the side panel
- "Disconnect" in the options page deletes stored tokens and revokes the grant at Google
- Uninstalling the extension removes all stored data

### Limited Use compliance

The extension's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements. Data is used solely to provide the
user-facing features described above, is never transferred to third parties, is never
used for advertising, and is never read by humans.

### Contact

Please open an issue at
https://github.com/keisuke-kimura/google-chat-chrome-extension/issues
