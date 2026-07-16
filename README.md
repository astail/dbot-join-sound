# dbot-join-sound

ボイスチャンネル（VC）の入室音 Bot。誰かが VC に入ると、その人が登録した音声（冒頭5秒まで）を再生します。

## 機能

- **入室音の登録**: Bot を直接 @メンションして音声ファイルを添付すると、送信者の入室音として登録（冒頭5秒でトリム、再登録は上書き）
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
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=3214336
```

（権限: View Channels / Send Messages / Read Message History / Connect / Speak）

### 2. 起動

```bash
cp .env.example .env   # DISCORD_TOKEN を記入
npm install
npm run build
npm start              # 開発時は npm run dev
```

Node.js 22.12 以上が必要。ffmpeg は `ffmpeg-static` 同梱のため別途インストール不要。

## 使い方

- `@Bot` + 音声ファイル添付 → 入室音を登録
- VC に入って `@Bot` → 通話に呼ぶ
- 登録済みの人が VC に入ると入室音が鳴る

音声は `sounds/<ユーザーID>.ogg` に保存されます（48kHz ogg/opus、最大5秒）。
