/* eslint-disable */
// Generated manually for smai-viva project
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./src/server");
    durableNamespaces: "VivaAgent" | "TopicsStore";
  }
  interface Env {
    AI: Ai;
    ANTHROPIC_API_KEY: string;
    DEEPGRAM_API_KEY: string;
    VivaAgent: DurableObjectNamespace<import("./src/viva-agent").VivaAgent>;
    TopicsStore: DurableObjectNamespace<import("./src/topics-store").TopicsStore>;
  }
}
interface Env extends Cloudflare.Env {}
type StringifyValues<EnvType extends Record<string, unknown>> = {
  [Binding in keyof EnvType]: EnvType[Binding] extends string
    ? EnvType[Binding]
    : string;
};
declare namespace NodeJS {
  interface ProcessEnv extends StringifyValues<
    Pick<Cloudflare.Env, "ANTHROPIC_API_KEY">
  > {}
}
