import { DiscordSDK } from "@discord/embedded-app-sdk";
import { exchangeDiscordCode, getDiscordClientId } from "./discord.functions";

let sdk: DiscordSDK | null = null;
let authenticated = false;

/** Discord only injects `frame_id` when the page runs inside a real Activity iframe. */
export function isInsideDiscord(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("frame_id");
}

export async function connectToDiscord(): Promise<{ username: string }> {
  if (!isInsideDiscord()) {
    throw new Error(
      "This page isn't running inside Discord. Launch it as an Activity in a voice channel to control your real presence.",
    );
  }

  const { clientId } = await getDiscordClientId();
  if (!clientId) {
    throw new Error("The Discord application ID hasn't been configured yet.");
  }

  if (!sdk) {
    sdk = new DiscordSDK(clientId);
    await sdk.ready();
  }

  if (!authenticated) {
    const { code } = await sdk.commands.authorize({
      client_id: clientId,
      response_type: "code",
      state: "",
      prompt: "none",
      scope: ["identify", "rpc.activities.write"],
    });

    const { accessToken } = await exchangeDiscordCode({ data: { code } });
    const auth = await sdk.commands.authenticate({ access_token: accessToken });
    authenticated = true;
    return { username: auth?.user?.global_name || auth?.user?.username || "you" };
  }

  return { username: "you" };
}

export async function publishActivity(activity: Record<string, unknown>): Promise<void> {
  if (!sdk || !authenticated) {
    throw new Error("Connect to Discord first.");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sdk.commands.setActivity({ activity: activity as any });
}

export async function resetActivity(): Promise<void> {
  if (!sdk || !authenticated) {
    throw new Error("Connect to Discord first.");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sdk.commands.setActivity({ activity: { type: 0 } as any });
}
