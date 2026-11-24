import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator, resolveProvider } from "../src/translator.ts";

test("MT_PROVIDER は deepl か anthropic、未指定なら deepl", () => {
  assert.equal(resolveProvider(undefined), "deepl");
  assert.equal(resolveProvider(""), "deepl");
  assert.equal(resolveProvider("DeepL"), "deepl");
  assert.equal(resolveProvider(" anthropic "), "anthropic");
  assert.throws(() => resolveProvider("google"), /MT_PROVIDER/);
});

test("使うエンジンの API キーがなければ翻訳を止める（null）", () => {
  assert.equal(createTranslator({}), null);
  assert.equal(createTranslator({ DEEPL_API_KEY: " " }), null);
  // もう一方のキーだけあっても使わない
  assert.equal(createTranslator({ MT_PROVIDER: "anthropic", DEEPL_API_KEY: "key:fx" }), null);
  assert.equal(createTranslator({ ANTHROPIC_API_KEY: "sk-ant-test" }), null);
});

test("キーがあれば選んだエンジンで翻訳する。Claude の既定のモデルは claude-haiku-5-5", () => {
  assert.equal(createTranslator({ DEEPL_API_KEY: "key:fx" })?.name, "DeepL");
  assert.equal(
    createTranslator({ MT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test" })?.name,
    "Claude (claude-haiku-5-5)",
  );
  assert.equal(
    createTranslator({
      MT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_MODEL: "claude-opus-5-5",
    })?.name,
    "Claude (claude-opus-5-5)",
  );
});

// 翻訳エンジンへの HTTP を差し替える。送られたリクエストを記録し、決めた応答を返す
type Sent = { url: string; body: Record<string, unknown> };
async function withFetch(
  respond: (url: string) => Response,
  run: (sent: Sent[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = input instanceof Request ? await input.text() : String(init?.body ?? "");
    sent.push({ url, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
    return respond(url);
  }) as typeof fetch;
  try {
    await run(sent);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function claudeMessage(content: unknown[], stopReason = "end_turn") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

const claude = () =>
  createTranslator({ MT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-test" })!;

test("Claude は考えた内容（thinking）を除いて訳文だけを返し、effort は low で頼む", async () => {
  await withFetch(
    () =>
      json(
        claudeMessage([
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: " 안녕하세요 " },
        ]),
      ),
    async (sent) => {
      assert.equal(await claude().translate("こんにちは", { from: "ja", to: "ko" }), "안녕하세요");
      assert.equal(sent.length, 1);
      assert.match(sent[0]!.url, /\/v1\/messages$/);
      assert.equal(sent[0]!.body.model, "claude-haiku-5-5");
      assert.deepEqual(sent[0]!.body.output_config, { effort: "low" });
      assert.match(String(sent[0]!.body.system), /日本語→韓国語の翻訳者/);
    },
  );
});

for (const stopReason of ["refusal", "max_tokens"]) {
  test(`Claude が ${stopReason} で止まったら、途中までの訳文があっても使わない`, async () => {
    await withFetch(
      () => json(claudeMessage([{ type: "text", text: "途中まで" }], stopReason)),
      async () => {
        await assert.rejects(
          claude().translate("こんにちは", { from: "ja", to: "ko" }),
          new RegExp(`途中で止まりました（stop_reason: ${stopReason}）`),
        );
      },
    );
  });
}

test("Claude が訳文を返さなければエラーにする", async () => {
  await withFetch(
    () => json(claudeMessage([{ type: "thinking", thinking: "", signature: "sig" }])),
    async () => {
      await assert.rejects(
        claude().translate("こんにちは", { from: "ja", to: "ko" }),
        /訳文を返しませんでした/,
      );
    },
  );
});

test("DeepL は無料プランのキー（:fx）なら無料版の接続先に送り、元の言語を指定する", async () => {
  await withFetch(
    () => json({ translations: [{ text: "안녕하세요" }] }),
    async (sent) => {
      const deepl = createTranslator({ DEEPL_API_KEY: "key:fx" })!;
      assert.equal(await deepl.translate("こんにちは", { from: "ja", to: "ko" }), "안녕하세요");
      assert.equal(sent[0]!.url, "https://api-free.deepl.com/v2/translate");
      assert.deepEqual(sent[0]!.body, { text: ["こんにちは"], source_lang: "JA", target_lang: "KO" });
    },
  );
});

test("DeepL は有料プランのキーなら有料版の接続先に送り、元の言語が不明なら判定を任せる", async () => {
  await withFetch(
    () => json({ translations: [{ text: "こんにちは" }] }),
    async (sent) => {
      const deepl = createTranslator({ DEEPL_API_KEY: "paid-key" })!;
      await deepl.translate("hello", { from: null, to: "ja" });
      assert.equal(sent[0]!.url, "https://api.deepl.com/v2/translate");
      assert.deepEqual(sent[0]!.body, { text: ["hello"], target_lang: "JA" });
    },
  );
});

test("DeepL がエラーを返したらエラーにする", async () => {
  await withFetch(
    () => new Response("Quota exceeded", { status: 456 }),
    async () => {
      const deepl = createTranslator({ DEEPL_API_KEY: "key:fx" })!;
      await assert.rejects(deepl.translate("こんにちは", { from: "ja", to: "ko" }), /DeepL 456/);
    },
  );
});
