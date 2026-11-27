import {
  CLIENT_CAPABILITIES_QUERY_PARAM,
  PROXY_LIMIT_RECOVERY_CAPABILITY,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { RpcServer } from "effect/rpc";

/*
 * A cliproxy recovery waits for its route, so its `limitRecovery.resetAt` is null. Upstream
 * clients require a reset time there, and they decode a shell or a thread as a whole, so one such
 * thread hides every chat. Clients that do not declare PROXY_LIMIT_RECOVERY_CAPABILITY get `null`
 * in its place: the thread still shows its usage limit error, without the pending recovery.
 */

export function declaresProxyLimitRecovery(url: string | URL): boolean {
  const parsed = typeof url === "string" ? URL.parse(url, "http://localhost") : url;
  const capabilities = parsed?.searchParams.getAll(CLIENT_CAPABILITIES_QUERY_PARAM) ?? [];
  return capabilities.some((value) => value.split(",").includes(PROXY_LIMIT_RECOVERY_CAPABILITY));
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// Both a thread's recovery and a recovery update name the stopped run.
const waitsForProxy = (value: unknown) =>
  isPlainObject(value) && value.resetAt === null && typeof value.runId === "string";

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    let copy: Array<unknown> | undefined;
    for (let index = 0; index < value.length; index++) {
      const item: unknown = value[index];
      const next = strip(item);
      if (next !== item) (copy ??= value.slice())[index] = next;
    }
    return copy ?? value;
  }
  if (!isPlainObject(value)) return value;
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(value)) {
    const item = value[key];
    const next = key === "limitRecovery" && waitsForProxy(item) ? null : strip(item);
    if (next !== item) (copy ??= { ...value })[key] = next;
  }
  return copy ?? value;
}

/**
 * Replaces every `limitRecovery` that waits for a proxy route with `null`, in encoded wire data.
 * It copies only the objects on the way to one, so shared encoded values stay untouched.
 */
export function withoutProxyLimitRecoveries<A>(value: A): A {
  return strip(value) as A;
}

const NULL_RESET_AT = /"resetAt"\s*:\s*null/;

/** The same, for JSON text; text without a null reset time is returned as is. */
export function withoutProxyLimitRecoveriesInJson(json: string): string {
  if (!NULL_RESET_AT.test(json)) return json;
  const value: unknown = JSON.parse(json);
  const next = strip(value);
  return next === value ? json : JSON.stringify(next);
}

/** The socket protocol for one connection: strips recoveries unless its URL declares them. */
export function forClientUrl(
  url: URL,
  protocol: RpcServer.Protocol["Service"],
): RpcServer.Protocol["Service"] {
  if (declaresProxyLimitRecovery(url)) return protocol;
  return {
    ...protocol,
    send: (clientId, response, transferables) =>
      Effect.suspend(() =>
        protocol.send(clientId, withoutProxyLimitRecoveries(response), transferables),
      ),
  };
}

const isJson = (contentType: string) =>
  contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";

const withJsonText = (
  response: HttpServerResponse.HttpServerResponse,
  text: string,
  contentType: string,
) => {
  const next = withoutProxyLimitRecoveriesInJson(text);
  return next === text
    ? response
    : HttpServerResponse.setBody(response, HttpBody.text(next, contentType));
};

const withoutProxyLimitRecoveriesInResponse = (
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  const body = response.body;
  if (body._tag === "Uint8Array" && isJson(body.contentType)) {
    const text = body.text ?? new TextDecoder().decode(body.body);
    return Effect.sync(() => withJsonText(response, text, body.contentType));
  }
  // A JSON body ends, unlike an event stream, so it can be read whole; the thread snapshot streams one.
  if (body._tag === "Stream" && isJson(body.contentType)) {
    return body.stream.pipe(
      Stream.decodeText,
      Stream.mkString,
      Effect.map((text) => withJsonText(response, text, body.contentType)),
      Effect.orDie,
    );
  }
  return Effect.succeed(response);
};

/** For the HTTP API routes: strips recoveries from JSON answers unless the request declares them. */
export const layerApiResponses = HttpRouter.middleware((httpEffect) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    declaresProxyLimitRecovery(request.url)
      ? httpEffect
      : Effect.flatMap(httpEffect, withoutProxyLimitRecoveriesInResponse),
  ),
).layer;
