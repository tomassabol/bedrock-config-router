/**
 * SigV4-signed streaming client for the /chat endpoint.
 *   npm run chat -- "Explain AppConfig in one paragraph"
 *   npm run chat -- "Summarize: ..." --route summarize --user alice
 */
import { parseArgs } from 'node:util';
import { Sha256 } from '@aws-crypto/sha256-js';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';

const REGION = 'eu-central-1';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    stage: { type: 'string', default: 'dev' },
    route: { type: 'string' },
    user: { type: 'string' },
    'max-tokens': { type: 'string' },
  },
});

async function chatUrl(): Promise<URL> {
  if (process.env.CHAT_URL) return new URL(process.env.CHAT_URL);
  const cfn = new CloudFormationClient({ region: REGION });
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: `BedrockConfigRouter-${values.stage}` }));
  const url = Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'ChatUrl')?.OutputValue;
  if (!url) throw new Error('ChatUrl output not found; deploy the stack first');
  return new URL(url);
}

async function main() {
  const prompt = positionals.join(' ');
  if (!prompt) throw new Error('Usage: npm run chat -- "<prompt>" [--route chat] [--user id]');
  const url = await chatUrl();
  const body = JSON.stringify({
    prompt,
    route: values.route,
    userId: values.user,
    maxTokens: values['max-tokens'] ? Number(values['max-tokens']) : undefined,
  });

  const signer = new SignatureV4({
    service: 'execute-api',
    region: REGION,
    credentials: fromNodeProviderChain(),
    sha256: Sha256,
  });
  const signed = await signer.sign({
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers: { host: url.hostname, 'content-type': 'application/json' },
    body,
  });

  const res = await fetch(url, { method: 'POST', headers: signed.headers, body });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(frame)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? 'null');
      if (event === 'delta') process.stdout.write(data.text);
      else console.error(`\n\x1b[2m[${event}] ${JSON.stringify(data)}\x1b[0m`);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
