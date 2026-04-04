export {};

declare module "socket.io" {
  interface SocketData {
    userId: string;
    /** Socket.io room id, e.g. `meeting:<code>`. */
    currentRoom?: string;
  }
}
