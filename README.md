# dbot-join-sound

ボイスチャンネル（VC）の入室音 Bot。誰かが VC に入ると、その人が登録した音声（冒頭8秒まで）を再生します。入室音を登録していない人は、VOICEVOX の音声合成で「〇〇さんが入室しました」と読み上げます。

## 機能

- **入室音の登録**: Bot を直接 @メンションして音声ファイルを添付すると、送信者の入室音として登録（冒頭8秒でトリム、再登録は上書き）。完了は ✅ リアクションで通知
- **登録音の確認**: 「check」を付けて @メンションすると、登録済みの入室音をリプライで返す
- **登録音の削除**: 「delete」を付けて @メンションすると、登録済みの入室音を削除する。削除した音声はリプライに添付されるので、添付し直せば元に戻せる
- **再生の無効化**: 「off」を付けて @メンションすると、自分の入室音も読み上げも鳴らなくなる（登録した音声は保持され、「on」で戻る）。Discord のサウンドボード等で既に入室音がある人向け
- **未登録ユーザーの読み上げ**: 入室音がない人は、表示名で「〇〇さんが入室しました」と読み上げ（VOICEVOX）
- **自動参加**: 未接続時に誰かが VC に入ると、その VC に自動参加して本人の入室音も再生
- **参加後は移動しない**: Bot のいるチャンネルに入った人の入室音だけ再生。他の VC への入室は無視
- **自動退出**: Bot 以外が全員いなくなったら即切断
- **メンションで召喚**: VC に入った状態で Bot を @メンション（添付なし）すると、その通話に参加

## セットアップ

### 1. Discord Developer Portal

1. <https://discord.com/developers/applications> でアプリケーションを作成
2. **Bot** タブでトークンを取得（**Privileged Gateway Intents は不要**。MESSAGE CONTENT INTENT も有効化不要 — Bot への直接メンションは制限免除のため）
3. 以下の URL でサーバーに招待（`CLIENT_ID` は置き換え）:

```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=3214400
```

（権限: View Channels / Send Messages / Add Reactions / Read Message History / Connect / Speak）

Add Reactions は登録完了を ✅ で示すために必要です。この権限を追加する前に招待した Bot は、登録は成功してもリアクションが付かないため、上記 URL で招待し直してください。

### 2. Docker Compose で起動

```bash
cp .env.example .env
# .env の DISCORD_TOKEN を設定
docker compose up -d --build
```

ログの確認と停止は、次のコマンドで行います。

```bash
docker compose logs -f bot
docker compose down
```

`docker compose up` すると、Bot と音声合成用の VOICEVOX Engine が起動します。VOICEVOX Engine のイメージは約 2GB あるため、初回の取得には時間がかかります。

登録した音声は Docker の `sounds` ボリュームに保存され、コンテナを作り直しても保持されます。`docker compose down -v` を実行すると登録音声も削除されるため注意してください。

登録音の再生音量はデフォルトで元音声の40%、VOICEVOX の読み上げは80%です。登録音は `.env` の `PLAYBACK_VOLUME`、VOICEVOX の読み上げは `VOICEVOX_VOLUME` で個別に変更できます。どちらも `0.0`（無音）から `1.0`（元音量）までの値を指定してください。

### 環境変数

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `DISCORD_TOKEN` | （必須） | Bot のトークン |
| `PLAYBACK_VOLUME` | `0.4` | 登録音の再生音量（`0.0`〜`1.0`） |
| `VOICEVOX_VOLUME` | `0.8` | VOICEVOX 読み上げの再生音量（`0.0`〜`1.0`） |
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

```text
@Bot + 音声ファイル  自分の入室音を登録（mp3 / wav / ogg など。長い音声は冒頭8秒を使用）
@Bot check            自分の入室音を確認
@Bot delete           自分の入室音を削除
@Bot off              自分の入室音・読み上げを無効化
@Bot on               自分の入室音・読み上げを有効化
@Bot                  自分がいる通話に参加
```

登録が完了すると ✅ が付きます。`delete` で削除した音声はリプライに添付されます。

- 登録済みの人が VC に入ると入室音が鳴る
- 入室音を登録していない人は VOICEVOX で読み上げられるため、`delete` すると読み上げに戻る
- 完全に無音にしたい場合は `delete` ではなく `off` を使う

音声は `sounds/<ユーザーID>.ogg` に保存されます（48kHz ogg/opus、最大8秒）。`off` にした人は同じ場所に `sounds/<ユーザーID>.off` という空ファイルが作られます。

最大8秒へ延長する前に登録した音声は5秒でトリムされたまま保存されています。8秒まで使いたい場合は登録し直してください。

## クレジット

未登録ユーザーの読み上げには [VOICEVOX](https://voicevox.hiroshiba.jp/) を使用しています。

VOICEVOX の[利用規約](https://voicevox.hiroshiba.jp/term/)により、生成した音声を利用する際は VOICEVOX を利用したことがわかるクレジット表記が必要です。加えて、話者ごとに個別の規約があります。`VOICEVOX_SPEAKER` で変更する場合は、その音声ライブラリの規約も確認してください。

デフォルトの話者は VOICEVOX:冥鳴ひまり（話者 ID 14）です。[冥鳴ひまりの利用規約](https://meimeihimari.wixsite.com/himari/terms-of-use)も確認してください。
