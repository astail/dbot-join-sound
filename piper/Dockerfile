# syntax=docker/dockerfile:1

# 韓国語の読み上げ用。Piper に付属の HTTP サーバーを、韓国語の声だけ入れて動かす
FROM python:3.12-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b

RUN pip install --no-cache-dir "piper-tts[http]==1.8.0"

# URL からの ADD は root 専用の権限で置かれるため、nobody でも読めるようにする
RUN install -d -m 755 /voices
# 声は Hugging Face のコミットとハッシュで固定する
ARG VOICE_URL=https://huggingface.co/rhasspy/piper-voices/resolve/e7229f7d33a10e145e109b886d661984201ac3c4/ko/ko_KR/kss/medium
ADD --chmod=644 --checksum=sha256:624fd774e26895f24bebae1bd9a3379e3394baeade4b584924f83e414096e2c9 ${VOICE_URL}/ko_KR-kss-medium.onnx /voices/
ADD --chmod=644 --checksum=sha256:153b5619d0580f824a59108d83ca19434de410eb8e4fe80325b58684fdc8a1df ${VOICE_URL}/ko_KR-kss-medium.onnx.json /voices/

USER nobody

CMD ["python", "-m", "piper.http_server", "-m", "/voices/ko_KR-kss-medium.onnx", "--host", "0.0.0.0", "--port", "5000"]
