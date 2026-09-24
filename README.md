# dbot-join-sound

ボイスチャンネル（VC）の入室音 Bot。誰かが VC に入ると、その人が登録した音声（冒頭8秒まで）を再生します。入室音を登録していない人は、VOICEVOX の音声合成で「〇〇が入室しました」と読み上げます。退室したときは全員共通で「〇〇が退室しました」と読み上げます。

## 機能

- **入室音の登録**: Bot を直接 @メンションして音声ファイルを添付すると、送信者の入室音として登録（冒頭8秒でトリム、再登録は上書き）。完了は ✅ リアクションで通知
- **登録音の確認**: 「check」を付けて @メンションすると、登録済みの入室音をリプライで返す
- **登録音の削除**: 「delete」を付けて @メンションすると、登録済みの入室音を削除する。削除した音声はリプライに添付されるので、添付し直せば元に戻せる
- **再生の無効化**: 「off」を付けて @メンションすると、自分の入室音も読み上げも鳴らなくなる（登録した音声は保持され、「on」で戻る）。Discord のサウンドボード等で既に入室音がある人向け
- **未登録ユーザーの読み上げ**: 入室音がない人は、表示名で「〇〇が入室しました」と読み上げ（VOICEVOX）
- **退室の読み上げ**: 誰かが VC から抜けると「〇〇が退室しました」と読み上げ。全員共通で、退室音は登録できない
- **チャットの読み上げ**: Bot が参加中の VC に付いているテキストチャットの発言を、本文だけ VOICEVOX で読み上げる。`/readchannel add` を実行したチャンネルの発言も読み上げる（Bot が通話にいる間だけ）
- **VC 付属チャットの自動削除**: VC に付いているテキストチャットで人が書いた発言を 30 秒後に削除（Bot の返信は残す）（`VC_CHAT_DELETE_SECONDS` で変更、`0` で無効）
- **読み方の登録**: `/yomi set` で「読み間違えられる単語 → 実際の読み方」を登録。表示名に部分一致した箇所を置き換えて読み上げる（`mame` → `まめ` を登録すれば `mamesan` も「まめさん」寄りに読まれる）
- **登録なしモード**: `JOIN_SOUND_ENABLED=false` で起動すると入室音の登録を受け付けず、登録済みの音声も鳴らさない（読み上げのみ）。音声は消えないので、`true` に戻せばまた鳴る
- **自動参加**: 未接続時に誰かが VC に入ると、その VC に自動参加して本人の入室音も再生
- **参加後は移動しない**: Bot のいるチャンネルに入った人の入室音だけ再生。他の VC への入室は無視
- **自動退出**: Bot 以外が全員いなくなったら即切断
- **コマンドで参加・退出**: VC に入った状態で `join` を付けて Bot を @メンションすると、その通話に参加。`leave` で参加中の通話から退出

## セットアップ

### 1. Discord Developer Portal

1. <https://discord.com/developers/applications> でアプリケーションを作成
2. **Bot** タブでトークンを取得し、**Privileged Gateway Intents の MESSAGE CONTENT INTENT を有効化**（チャットの読み上げに本文が必要なため。有効化しないと起動時に `Used disallowed intents` で接続できない）
3. 以下の URL でサーバーに招待（`CLIENT_ID` は置き換え）:

```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=3222592
```

（権限: View Channels / Send Messages / Manage Messages / Add Reactions / Read Message History / Connect / Speak）

Manage Messages は VC 付属チャットの自動削除に使います。招待済みのサーバーでは、この URL を踏み直すか、サーバー設定で Bot のロールに「メッセージの管理」を付けてください。権限がなくても読み上げは動き、削除だけが失敗してログに残ります。

`applications.commands` はスラッシュコマンド（`/yomi` と `/readchannel`）の登録に必要です。すでに `scope=bot` だけで招待済みのサーバーでも、この URL を踏み直せばスコープが追加されます。Bot は退出せず、登録済みの入室音も残ります。

### 2. Docker Compose で起動

```bash
cp .env.example .env
# .env の DISCORD_TOKEN を設定
GIT_COMMIT=$(git describe --always --dirty) docker compose up -d --build
```

`GIT_COMMIT` はビルド中のコミットハッシュを Bot のカスタムステータスに表示するためのものです。付けずに起動すると `unknown` と表示されるだけで、動作自体は変わりません。

`rev-parse` ではなく `describe --always --dirty` を使うのは、未コミットの変更を含むイメージに `26b7835-dirty` のような印を付けるためです。ハッシュだけだと、手元で書きかけのコードをビルドしても、そのコミットの内容が動いているように見えてしまいます。

ログの確認と停止は、次のコマンドで行います。

```bash
docker compose logs -f bot
docker compose down
```

`docker compose up` すると、Bot と音声合成用の VOICEVOX Engine が起動します。VOICEVOX Engine のイメージは約 2GB あるため、初回の取得には時間がかかります。

登録した音声は Docker の `sounds` ボリュームに保存され、コンテナを作り直しても保持されます。`docker compose down -v` を実行すると登録音声も削除されるため注意してください。

登録音の再生音量はデフォルトで元音声の40%、VOICEVOX の読み上げは80%です。登録音は `.env` の `PLAYBACK_VOLUME`、VOICEVOX の読み上げは `VOICEVOX_VOLUME` で個別に変更できます。どちらも `0.0`（無音）から `1.0`（元音量）までの値を指定してください。

入退室してすぐには鳴らさず、0.5 秒ほど間を置いてから再生します。長さは `.env` の `ANNOUNCE_DELAY_MS` で変更でき、`0` を指定すると従来どおり即座に鳴ります。読み上げの場合はこの待ちと音声合成が並行して進むため、登録音でも読み上げでも間の長さは変わりません。

登録音は突然鳴って驚かないよう、無音から再生音量まで約 1 秒かけて上げます。長さは `.env` の `JOIN_SOUND_FADE_IN_MS` で変更でき、`0` を指定するとフェードなしで従来どおり鳴ります。音声変換がバッファで少し先を処理する分、実際に聞こえるフェードは指定値よりわずかに長くなります。

読み上げだけで運用したいときは、`.env` の `JOIN_SOUND_ENABLED` に `false` を指定して起動します。このモードでは入室音の登録を受け付けず、すでに登録されている音声も鳴らさずに読み上げへ回します。登録済みの音声は削除されないため、`true`（既定）に戻して起動し直せば元どおり鳴ります。`check` と `delete` はこのモードでも使えるので、保持されている音声の取り出しや削除はいつでもできます。

### 環境変数

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `DISCORD_TOKEN` | （必須） | Bot のトークン |
| `JOIN_SOUND_ENABLED` | `true` | `false` で入室音の登録・再生を止める（読み上げのみ） |
| `PLAYBACK_VOLUME` | `0.4` | 登録音の再生音量（`0.0`〜`1.0`） |
| `VOICEVOX_VOLUME` | `0.8` | VOICEVOX 読み上げの再生音量（`0.0`〜`1.0`） |
| `JOIN_SOUND_FADE_IN_MS` | `1000` | 登録音のフェードイン時間（`0`〜`8000` ミリ秒、`0` で無効） |
| `VC_CHAT_DELETE_SECONDS` | `30` | VC 付属チャットの発言を消すまでの秒数（`0`〜`86400`、`0` で消さない） |
| `ANNOUNCE_DELAY_MS` | `500` | 入退室から鳴らし始めるまでの待ち（`0`〜`5000` ミリ秒、`0` で即時） |
| `VOICEVOX_SPEAKER` | `14` | 読み上げの話者 ID |
| `VOICEVOX_URL` | `http://voicevox:50021` | VOICEVOX Engine の接続先 |
| `VOICEVOX_TIMEOUT_MS` | `10000` | 音声合成のタイムアウト（ミリ秒） |

話者 ID の一覧は、起動後に `docker compose exec bot node -e "fetch('http://voicevox:50021/speakers').then(r=>r.json()).then(s=>console.log(s.flatMap(v=>v.styles.map(t=>t.id+' '+v.name+'('+t.name+')')).join('\n')))"` で確認できます。

VOICEVOX Engine が停止していても Bot は動き続け、読み上げだけがスキップされます（登録済みの入室音は再生されます）。

### 3. ローカルで起動

```bash
cp .env.example .env   # DISCORD_TOKEN を記入
npm install
npm run build
npm start              # 開発時は npm run dev
```

Node.js 22.12 以上が必要。ffmpeg は `ffmpeg-static` 同梱のため別途インストール不要。

## 使い方

### 入室音（Bot へのメンション）

```text
@Bot + 音声ファイル  自分の入室音を登録（mp3 / wav / ogg など。長い音声は冒頭8秒を使用）
@Bot check            自分の入室音を確認
@Bot delete           自分の入室音を削除
@Bot off              自分の入室音と入退室の読み上げを無効化
@Bot on               自分の入室音と入退室の読み上げを有効化
@Bot join             自分がいる通話に参加
@Bot leave            参加中の通話から退出
```

登録が完了すると ✅ が付きます。`delete` で削除した音声はリプライに添付されます。

- 登録済みの人が VC に入ると入室音が鳴る
- 入室音を登録していない人は VOICEVOX で読み上げられるため、`delete` すると読み上げに戻る
- 完全に無音にしたい場合は `delete` ではなく `off` を使う（退室の読み上げも鳴らなくなる）
- 退室の読み上げは全員共通で、登録音には差し替えられない。最後の 1 人が抜けたときは Bot も同時に切断するため鳴らない
- `JOIN_SOUND_ENABLED=false` で起動している間は登録できず、登録済みの人も入室で読み上げられる。使い方にも登録の案内は出ない

音声は `sounds/<ユーザーID>.ogg` に保存されます（48kHz ogg/opus、最大8秒）。`off` にした人は同じ場所に `sounds/<ユーザーID>.off` という空ファイルが作られます。

最大8秒へ延長する前に登録した音声は5秒でトリムされたまま保存されています。8秒まで使いたい場合は登録し直してください。

### チャットの読み上げ

Bot が通話に参加している間、次のチャンネルの発言を本文だけ読み上げます。

- Bot が参加中の VC に付いているテキストチャット（設定不要）
- `/readchannel add` を実行したチャンネル

```text
/readchannel add     このチャンネルのチャットを読み上げる
/readchannel remove  このチャンネルのチャットを読み上げない
/readchannel list    読み上げるチャンネルの一覧（VC 付属チャットは含まない）
```

- 入退室の音と同じ順番待ちに並ぶので、重なって鳴ることはない
- URL は「URL」、伏せ字（`||…||`）は「伏せ字」と読み、カスタム絵文字は読まない。100 文字を超える部分は「以下略」で打ち切る
- `/yomi` で登録した読み方はチャットにも効く
- Bot の発言と、Bot へのメンション（`@Bot check` などのコマンド）は読まない
- 読み上げるチャンネルは `sounds/readchannels.json` に保存され、全サーバー共通の 1 ファイルで持つ

VC 付属のテキストチャットは、どの VC のものでも発言から 30 秒で自動的に削除されます（Bot が参加していない VC も対象）。消すのは人の発言だけで、Bot の返信は残ります（`@Bot delete` の返信に添付される削除した音声の控えを消さないため）。削除の予約はメモリ上に持つので、30 秒以内に Bot を再起動した発言は消えずに残ります。

### 読み方（スラッシュコマンド）

VOICEVOX が名前を読み違えるとき（`mame` を「めいむ」と読んでしまう等）に登録します。

```text
/yomi set word:mame reading:まめ   読み方を登録（登録済みなら上書き）
/yomi delete word:mame             登録した読み方を削除
/yomi list                         登録されている読み方の一覧
```

- 表示名に**部分一致**した箇所を置き換える。`mame` → `まめ` を登録しておけば `mamesan` も「まめさん」寄りに読まれる一方、`tamame` のような無関係な名前にも効いてしまう
- 大文字小文字は区別しない（`Mame` でも `MAME` でも一致）。登録時は小文字にそろえて保存される
- 同じ位置に複数当てはまるときは長い単語が優先される（`mame` と `mamesan` の両方があれば `mamesan` の読みを使う）
- 辞書は Bot 全体で共通。誰でも登録・削除でき、ユーザーごとの設定ではない
- 入室音を登録している人は入室では音が鳴るので、読み方が効くのは退室の読み上げとチャットの読み上げだけ

読み方は `sounds/yomi.json` に保存され、入室音と同じボリュームで保持されます。

コマンドは Bot が参加しているサーバーごとに、起動時と招待時に登録されます（反映は即時）。

## クレジット

未登録ユーザーの読み上げには [VOICEVOX](https://voicevox.hiroshiba.jp/) を使用しています。

VOICEVOX の[利用規約](https://voicevox.hiroshiba.jp/term/)により、生成した音声を利用する際は VOICEVOX を利用したことがわかるクレジット表記が必要です。加えて、話者ごとに個別の規約があります。`VOICEVOX_SPEAKER` で変更する場合は、その音声ライブラリの規約も確認してください。

デフォルトの話者は VOICEVOX:冥鳴ひまり（話者 ID 14）です。[冥鳴ひまりの利用規約](https://meimeihimari.wixsite.com/himari/terms-of-use)も確認してください。
