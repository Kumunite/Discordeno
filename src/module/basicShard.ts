import { delay, inflate } from "../../deps.ts";
import {
  DiscordBotGatewayData,
  DiscordHeartbeatPayload,
  GatewayOpcode,
  ReadyPayload,
} from "../types/discord.ts";
import { FetchMembersOptions } from "../types/guild.ts";
import { BotStatusRequest } from "../utils/utils.ts";
import {
  botGatewayData,
  eventHandlers,
  IdentifyPayload,
  identifyPayload,
} from "./client.ts";
import { handleDiscordPayload } from "./shardingManager.ts";

const basicShards = new Map<number, BasicShard>();
const heartbeating = new Map<number, boolean>();
const utf8decoder = new TextDecoder();
const RequestMembersQueue: RequestMemberQueuedRequest[] = [];
let processQueue = false;

export interface BasicShard {
  id: number;
  ws: WebSocket;
  resumeInterval: number;
  sessionID: string;
  previousSequenceNumber: number | null;
  needToResume: boolean;
}

interface RequestMemberQueuedRequest {
  guildID: string;
  shardID: number;
  nonce: string;
  options?: FetchMembersOptions;
}

export async function createBasicShard(
  data: DiscordBotGatewayData,
  identifyPayload: IdentifyPayload,
  resuming = false,
  shardID = 0,
) {
  const oldShard = basicShards.get(shardID);

  const gatewayURL = `${data.url}?v=8&encoding=json`;
  const basicShard: BasicShard = {
    id: shardID,
    ws: new WebSocket(gatewayURL),
    resumeInterval: 0,
    sessionID: oldShard?.sessionID || "",
    previousSequenceNumber: oldShard?.previousSequenceNumber || 0,
    needToResume: false,
  };

  basicShards.set(basicShard.id, basicShard);

  basicShard.ws.onopen = async () => {
    if (!resuming) {
      // Intial identify with the gateway
      identify(basicShard, identifyPayload);
    } else {
      resume(basicShard, identifyPayload);
    }
  };

  basicShard.ws.onclose = (closeEvent) =>
    handleCloseEvent(shardID, basicShard, closeEvent);

  basicShard.ws.onmessage = (messageEvent) =>
    handleMessageEvent(shardID, basicShard, messageEvent);
}

function handleCloseEvent(
  shardID: number,
  basicShard: BasicShard,
  closeEvent: CloseEvent,
) {
  eventHandlers.debug?.(
    {
      type: "wsClose",
      data: { shardID: basicShard.id, event: closeEvent },
    },
  );

  // These error codes should just crash the projects
  if ([4004, 4005, 4012, 4013, 4014].includes(closeEvent.code)) {
    eventHandlers.debug?.(
      {
        type: "wsError",
        data: { shardID: basicShard.id, event: closeEvent },
      },
    );

    throw new Error(
      "Shard.ts: Error occurred that is not resumeable or able to be reconnected.",
    );
  }

  // These error codes can not be resumed but need to reconnect from start
  if ([4003, 4007, 4008, 4009].includes(closeEvent.code)) {
    eventHandlers.debug?.(
      {
        type: "wsReconnect",
        data: { shardID: basicShard.id, event: closeEvent },
      },
    );
    createBasicShard(botGatewayData, identifyPayload, false, shardID);
  } else {
    basicShard.needToResume = true;
    resumeConnection(botGatewayData, identifyPayload, basicShard.id);
  }
}

function handleMessageEvent(
  shardID: number,
  basicShard: BasicShard,
  messageEvent: MessageEvent,
) {
  let message = messageEvent.data;

  if (message instanceof Uint8Array) {
    message = inflate(
      message,
      0,
      (slice: Uint8Array) => utf8decoder.decode(slice),
    );
  }

  if (typeof message === "string") {
    const data = JSON.parse(message);
    if (!data.t) eventHandlers.rawGateway?.(data);
    switch (data.op) {
      case GatewayOpcode.Hello:
        if (!heartbeating.has(basicShard.id)) {
          heartbeat(
            basicShard,
            (data.d as DiscordHeartbeatPayload).heartbeat_interval,
            identifyPayload,
          );
        }
        break;
      case GatewayOpcode.HeartbeatACK:
        heartbeating.set(shardID, true);
        break;
      case GatewayOpcode.Reconnect:
        eventHandlers.debug?.(
          { type: "reconnect", data: { shardID: basicShard.id } },
        );
        basicShard.needToResume = true;
        resumeConnection(botGatewayData, identifyPayload, basicShard.id);
        break;
      case GatewayOpcode.InvalidSession:
        eventHandlers.debug?.(
          { type: "invalidSession", data: { shardID: basicShard.id, data } },
        );
        // When d is false we need to reidentify
        if (!data.d) {
          createBasicShard(botGatewayData, identifyPayload, false, shardID);
          break;
        }
        basicShard.needToResume = true;
        resumeConnection(botGatewayData, identifyPayload, basicShard.id);
        break;
      default:
        if (data.t === "RESUMED") {
          eventHandlers.debug?.(
            { type: "resumed", data: { shardID: basicShard.id } },
          );

          basicShard.needToResume = false;
          break;
        }
        // Important for RESUME
        if (data.t === "READY") {
          basicShard.sessionID = (data.d as ReadyPayload).session_id;
        }

        // Update the sequence number if it is present
        if (data.s) basicShard.previousSequenceNumber = data.s;

        handleDiscordPayload(data, basicShard.id);
        break;
    }
  }
}

function identify(shard: BasicShard, payload: IdentifyPayload) {
  eventHandlers.debug?.(
    {
      type: "identifying",
      data: {
        shardID: shard.id,
      },
    },
  );

  return shard.ws.send(
    JSON.stringify(
      {
        op: GatewayOpcode.Identify,
        d: { ...payload, shard: [shard.id, payload.shard[1]] },
      },
    ),
  );
}

function resume(shard: BasicShard, payload: IdentifyPayload) {
  return shard.ws.send(JSON.stringify({
    op: GatewayOpcode.Resume,
    d: {
      token: payload.token,
      session_id: shard.sessionID,
      seq: shard.previousSequenceNumber,
    },
  }));
}

async function heartbeat(
  shard: BasicShard,
  interval: number,
  payload: IdentifyPayload,
) {
  // We lost socket connection between heartbeats, resume connection
  if (shard.ws.readyState === WebSocket.CLOSED) {
    shard.needToResume = true;
    resumeConnection(botGatewayData, payload, shard.id);
    heartbeating.delete(shard.id);
    return;
  }

  if (heartbeating.has(shard.id)) {
    const receivedACK = heartbeating.get(shard.id);
    // If a ACK response was not received since last heartbeat, issue invalid session close
    if (!receivedACK) {
      eventHandlers.debug?.(
        {
          type: "heartbeatStopped",
          data: {
            interval,
            previousSequenceNumber: shard.previousSequenceNumber,
            shardID: shard.id,
          },
        },
      );
      return shard.ws.send(JSON.stringify({ op: 4009 }));
    }
  }

  // Set it to false as we are issuing a new heartbeat
  heartbeating.set(shard.id, false);

  shard.ws.send(
    JSON.stringify(
      { op: GatewayOpcode.Heartbeat, d: shard.previousSequenceNumber },
    ),
  );
  eventHandlers.debug?.(
    {
      type: "heartbeat",
      data: {
        interval,
        previousSequenceNumber: shard.previousSequenceNumber,
        shardID: shard.id,
      },
    },
  );
  await delay(interval);
  heartbeat(shard, interval, payload);
}

async function resumeConnection(
  botGatewayData: DiscordBotGatewayData,
  payload: IdentifyPayload,
  shardID: number,
) {
  const shard = basicShards.get(shardID);
  if (!shard) {
    eventHandlers.debug?.(
      { type: "missingShard", data: { shardID: shardID } },
    );
    return;
  }

  if (!shard.needToResume) return;

  eventHandlers.debug?.({ type: "resuming", data: { shardID: shard.id } });
  // Run it once
  createBasicShard(botGatewayData, payload, true, shard.id);
  // Then retry every 15 seconds
  await delay(1000 * 15);
  if (shard.needToResume) resumeConnection(botGatewayData, payload, shardID);
}

export function requestGuildMembers(
  guildID: string,
  shardID: number,
  nonce: string,
  options?: FetchMembersOptions,
  queuedRequest = false,
) {
  const shard = basicShards.get(shardID);

  // This request was not from this queue so we add it to queue first
  if (!queuedRequest) {
    RequestMembersQueue.push({
      guildID,
      shardID,
      nonce,
      options,
    });

    if (!processQueue) {
      processQueue = true;
      processGatewayQueue();
    }
    return;
  }

  // If its closed add back to queue to redo on resume
  if (shard?.ws.readyState === WebSocket.CLOSED) {
    requestGuildMembers(guildID, shardID, nonce, options);
    return;
  }

  shard?.ws.send(JSON.stringify({
    op: GatewayOpcode.RequestGuildMembers,
    d: {
      guild_id: guildID,
      query: options?.query || "",
      limit: options?.limit || 0,
      presences: options?.presences || false,
      user_ids: options?.userIDs,
      nonce,
    },
  }));
}

async function processGatewayQueue() {
  if (!RequestMembersQueue.length) {
    processQueue = false;
    return;
  }

  basicShards.forEach((shard) => {
    const index = RequestMembersQueue.findIndex((q) => q.shardID === shard.id);
    // 2 events per second is the rate limit.
    const request = RequestMembersQueue[index];
    if (request) {
      eventHandlers.debug?.(
        {
          type: "requestMembersProcessing",
          data: {
            remaining: RequestMembersQueue.length,
            request,
          },
        },
      );
      requestGuildMembers(
        request.guildID,
        request.shardID,
        request.nonce,
        request.options,
        true,
      );
      // Remove item from queue
      RequestMembersQueue.splice(index, 1);

      const secondIndex = RequestMembersQueue.findIndex((q) =>
        q.shardID === shard.id
      );
      const secondRequest = RequestMembersQueue[secondIndex];
      if (secondRequest) {
        eventHandlers.debug?.(
          {
            type: "requestMembersProcessing",
            data: {
              remaining: RequestMembersQueue.length,
              request,
            },
          },
        );
        requestGuildMembers(
          secondRequest.guildID,
          secondRequest.shardID,
          secondRequest.nonce,
          secondRequest.options,
          true,
        );
        // Remove item from queue
        RequestMembersQueue.splice(secondIndex, 1);
      }
    }
  });

  await delay(1500);

  processGatewayQueue();
}

export function botGatewayStatusRequest(payload: BotStatusRequest) {
  basicShards.forEach((shard) => {
    shard.ws.send(JSON.stringify({
      op: GatewayOpcode.StatusUpdate,
      d: {
        since: null,
        game: payload.game.name
          ? {
            name: payload.game.name,
            type: payload.game.type,
          }
          : null,
        status: payload.status,
        afk: false,
      },
    }));
  });
}
