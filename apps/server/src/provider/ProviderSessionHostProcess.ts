import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderContinuationHost from "./ProviderContinuationHost.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { layerProviderSessionInfrastructure } from "../server.ts";
import * as ProviderSessionHost from "./ProviderSessionHost.ts";
import * as ProviderMcpIngress from "./ProviderMcpIngress.ts";
import * as ProviderSessionJournal from "./ProviderSessionJournal.ts";
import * as ProviderSessionTransport from "./ProviderSessionTransport.ts";
import { BackendDaemonReady } from "../backendDaemonReady.ts";

const journal = ProviderSessionJournal.layer.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        return NodeSqliteClient.layer({
          filename: path.join(config.stateDir, "provider-host.sqlite"),
        });
      }),
    ),
  ),
);

const layer = Layer.merge(
  ProviderSessionTransport.layerServer,
  ProviderContinuationHost.layerWorker,
).pipe(
  Layer.provide(ProviderContinuationHost.layer),
  Layer.provideMerge(ProviderSessionHost.layer.pipe(Layer.provide(journal))),
  Layer.provide(ProviderMcpIngress.layer),
  Layer.provide(layerProviderSessionInfrastructure),
  Layer.provide(ProviderContinuationRequests.layer),
);

export const run = Layer.launch(
  layer.pipe(Layer.tap(() => Effect.flatMap(BackendDaemonReady, (ready) => ready))),
);
