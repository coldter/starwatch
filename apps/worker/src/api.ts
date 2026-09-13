import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Schema from "effect/Schema";

/** The API spec is a pure value: clients can import it without Worker code. */

export const Health = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.String,
  version: Schema.String
});

export const DbTime = Schema.Struct({
  now: Schema.String
});

export const VectorInfo = Schema.Struct({
  vectorCount: Schema.Number,
  dimensions: Schema.Number
});

export const BucketProbe = Schema.Struct({
  found: Schema.Boolean
});

const systemGroup = HttpApiGroup.make("system")
  .add(HttpApiEndpoint.get("health", "/health", { success: Health }))
  .add(HttpApiEndpoint.get("dbTime", "/db/time", { success: DbTime }))
  .add(
    HttpApiEndpoint.get("vectorInfo", "/vectors/info", {
      success: VectorInfo
    })
  )
  .add(
    HttpApiEndpoint.get("bucketProbe", "/bucket/probe", {
      success: BucketProbe
    })
  );

export const StarwatchApi = HttpApi.make("StarwatchApi").add(systemGroup);
