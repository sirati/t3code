import { MarkedText, markedTextEnglish, translatableMessage } from "../errors/translatable.ts";
import { msg } from "gt-i18n";
import {
  CLIENT_CAPABILITIES_QUERY_PARAM,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  PROXY_LIMIT_RECOVERY_CAPABILITY,
  type EnvironmentAuthInvalidError,
  type EnvironmentConnectApprovalPendingError,
  type EnvironmentInternalError,
  type EnvironmentOperationForbiddenError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
  type EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as HttpObservability from "@t3tools/shared/httpObservability";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class RemoteEnvironmentAuthFetchError extends Schema.TaggedError<RemoteEnvironmentAuthFetchError>()(
  "RemoteEnvironmentAuthFetchError",
  {
    message: Schema.String,
    i18nMessage: Schema.optionalKey(MarkedText),
    cause: Schema.Defect(),
  },
) {}

class RemoteEnvironmentAuthInvalidJsonError extends Schema.TaggedError<RemoteEnvironmentAuthInvalidJsonError>()(
  "RemoteEnvironmentAuthInvalidJsonError",
  {
    message: Schema.String,
    i18nMessage: Schema.optionalKey(MarkedText),
    cause: Schema.Defect(),
  },
) {}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Schema.TaggedError<RemoteEnvironmentAuthUndeclaredStatusError>()(
  "RemoteEnvironmentAuthUndeclaredStatusError",
  {
    status: Schema.Number,
    requestUrl: Schema.String,
  },
) {
  override get message(): string {
    return markedTextEnglish(this.i18nMessage);
  }

  get i18nMessage(): MarkedText {
    return [
      msg("Remote environment endpoint {url} returned undeclared status {status}.", {
        url: this.requestUrl,
        status: String(this.status),
      }),
    ];
  }
}

export class RemoteEnvironmentAuthTimeoutError extends Schema.TaggedError<RemoteEnvironmentAuthTimeoutError>()(
  "RemoteEnvironmentAuthTimeoutError",
  {
    requestUrl: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return markedTextEnglish(this.i18nMessage);
  }

  get i18nMessage(): MarkedText {
    return [
      msg("Remote environment endpoint {url} timed out after {timeoutMs}ms.", {
        url: this.requestUrl,
        timeoutMs: String(this.timeoutMs),
      }),
    ];
  }
}

const isRemoteEnvironmentAuthTimeoutError = Schema.is(RemoteEnvironmentAuthTimeoutError);

export type RemoteEnvironmentRequestError =
  | EnvironmentRequestInvalidError
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentOperationForbiddenError
  | EnvironmentResourceNotFoundError
  | EnvironmentInternalError
  | EnvironmentConnectApprovalPendingError
  | RemoteEnvironmentAuthFetchError
  | RemoteEnvironmentAuthInvalidJsonError
  | RemoteEnvironmentAuthUndeclaredStatusError
  | RemoteEnvironmentAuthTimeoutError;

export const layerRemoteHttpClient = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.merge(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    HttpObservability.layer,
  );

const remoteApiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

// HTTP requests carry no socket URL, so orchestration requests, whose answers hold thread records,
// declare this wire shape as a query parameter. It is a parameter, not a header, because a header
// outside the CORS allowlist fails the preflight to other servers.
const isOrchestrationRequest = (url: string) => url.includes("/api/orchestration/");

/** The URL an orchestration request sends, for signing; other URLs are returned as is. */
export const withProxyLimitRecoveryCapability = (url: string): string =>
  isOrchestrationRequest(url)
    ? `${url}${url.includes("?") ? "&" : "?"}${CLIENT_CAPABILITIES_QUERY_PARAM}=${PROXY_LIMIT_RECOVERY_CAPABILITY}`
    : url;

const declareProxyLimitRecovery = HttpClient.mapRequest((request) =>
  isOrchestrationRequest(request.url)
    ? HttpClientRequest.appendUrlParam(
        request,
        CLIENT_CAPABILITIES_QUERY_PARAM,
        PROXY_LIMIT_RECOVERY_CAPABILITY,
      )
    : request,
);

export const makeEnvironmentHttpApiClient = (httpBaseUrl: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
    transformClient: declareProxyLimitRecovery,
  });

export const makeEnvironmentHttpApiGroupClient = <
  Group extends keyof typeof EnvironmentHttpApi.groups,
>(
  httpBaseUrl: string,
  group: Group,
) =>
  Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
    HttpApiClient.group(EnvironmentHttpApi, {
      httpClient: declareProxyLimitRecovery(httpClient),
      group,
      baseUrl: remoteApiBaseUrl(httpBaseUrl),
    }),
  );

export const makeEnvironmentHttpApiUrlBuilder = (httpBaseUrl: string) =>
  HttpApiClient.urlBuilder(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });

const failRemoteRequest = (
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, RemoteEnvironmentRequestError> => {
  if (isRemoteEnvironmentAuthTimeoutError(cause)) {
    return Effect.fail(cause);
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(cause);
  }
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        ...translatableMessage(
          msg("Remote environment endpoint returned an invalid response from {url}.", {
            url: requestUrl,
          }),
        ),
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const response = cause.response;
    if (response.status < 200 || response.status >= 300) {
      return Effect.fail(
        new RemoteEnvironmentAuthUndeclaredStatusError({ requestUrl, status: response.status }),
      );
    }
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        ...translatableMessage(
          msg("Remote environment endpoint returned an invalid response from {url}.", {
            url: requestUrl,
          }),
        ),
        cause,
      }),
    );
  }
  return Effect.fail(
    new RemoteEnvironmentAuthFetchError({
      ...translatableMessage(
        msg("Failed to fetch remote environment endpoint {url} ({cause}).", {
          url: requestUrl,
          cause: String(cause),
        }),
      ),
      cause,
    }),
  );
};

export const executeEnvironmentHttpRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteEnvironmentRequestError, R> =>
  request.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RemoteEnvironmentAuthTimeoutError({ requestUrl, timeoutMs })),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRemoteRequest(requestUrl, cause)),
  );
