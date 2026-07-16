# dbot-join-sound

ボイスチャンネル（VC）の入室音 Bot。誰かが VC に入ると、その人が登録した音声（冒頭8秒まで）を再生します。

## 機能

- **入室音の登録**: Bot を直接 @メンションして音声ファイルを添付すると、送信者の入室音として登録（冒頭8秒でトリム、再登録は上書き）。完了は ✅ リアクションで通知
- **登録音の確認**: 「check」を付けて @メンションすると、登録済みの入室音をリプライで返す
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

登録した音声は Docker の `sounds` ボリュームに保存され、コンテナを作り直しても保持されます。`docker compose down -v` を実行すると登録音声も削除されるため注意してください。

再生音量はデフォルトで元音声の20%です。変更する場合は `.env` の `PLAYBACK_VOLUME` に `0.0`（無音）から `1.0`（元音量）までの値を指定してください。

### 3. ローカルで起動

```bash
cp .env.example .env   # DISCORD_TOKEN を記入
npm install
npm run build
npm start              # 開発時は npm run dev
```

Node.js 22.12 以上が必要。ffmpeg は `ffmpeg-static` 同梱のため別途インストール不要。

## 使い方

- `@Bot` + 音声ファイル添付 → 入室音を登録（完了すると ✅ が付く）
- `@Bot check` → 登録済みの入室音がリプライで返る
- VC に入って `@Bot` → 通話に呼ぶ
- 登録済みの人が VC に入ると入室音が鳴る

音声は `sounds/<ユーザーID>.ogg` に保存されます（48kHz ogg/opus、最大8秒）。

最大8秒へ延長する前に登録した音声は5秒でトリムされたまま保存されています。8秒まで使いたい場合は登録し直してください。
