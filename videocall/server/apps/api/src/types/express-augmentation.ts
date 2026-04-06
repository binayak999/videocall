/**
 * Side-effect module so ts-node always merges `userId` onto Express.Request
 * (see tsconfig `ts-node.files` as well).
 */
export {};

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}
