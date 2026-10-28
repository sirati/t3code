import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

class HostDescriptorError extends Schema.TaggedError<HostDescriptorError>()(
  "HostDescriptorError",
  {},
) {
  override get message() {
    return "The provider host requires a private descriptor owned by the current user.";
  }
}

const descriptor = Schema.fromJsonString(
  Schema.Struct({
    endpoint: Schema.String.check(Schema.isMinLength(1)),
    token: Schema.String.check(Schema.isMinLength(32)),
  }),
);

export const read = Effect.fn("ProviderHostDescriptor.read")(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  const uid = yield* HostProcess.UserId;
  const platform = yield* HostProcess.Platform;
  const stat = yield* fs.stat(filename);
  if (
    stat.type !== "File" ||
    (platform !== "win32" &&
      (uid === undefined || Option.getOrUndefined(stat.uid) !== uid || (stat.mode & 0o077) !== 0))
  )
    return yield* new HostDescriptorError();
  return yield* fs
    .readFileString(filename)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(descriptor)));
});
