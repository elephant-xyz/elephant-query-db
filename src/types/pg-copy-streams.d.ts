declare module "pg-copy-streams" {
  import type { Duplex } from "node:stream";
  import type { Submittable } from "pg";

  export interface CopyStreamQuery extends Duplex, Submittable {}

  export function from(copyFromStatement: string): CopyStreamQuery;
  export function to(copyToStatement: string): CopyStreamQuery;
}
