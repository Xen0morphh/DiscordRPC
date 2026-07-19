declare module "discord-rpc" {
  export type PresenceButton = {
    label: string;
    url: string;
  };

  export type Presence = {
    details?: string;
    state?: string;
    startTimestamp?: number | Date;
    endTimestamp?: number | Date;
    largeImageKey?: string;
    largeImageText?: string;
    smallImageKey?: string;
    smallImageText?: string;
    buttons?: PresenceButton[];
    instance?: boolean;
  };

  export class Client {
    constructor(options: { transport: "ipc" | "websocket" });
    login(options: { clientId: string }): Promise<this>;
    setActivity(activity: Presence): Promise<void>;
    clearActivity(): Promise<void>;
    destroy(): Promise<void>;
  }

  const DiscordRPC: {
    Client: typeof Client;
    register(clientId: string): void;
  };

  export default DiscordRPC;
}
