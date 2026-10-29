import { fetchAI } from './lib/ai-client.ts';

async function test() {
  const res = await fetchAI({
    model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    messages: [{ role: "user", content: "Hello" }]
  });
  console.log("Result:", res);
}
test();
