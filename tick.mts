import type { Config } from "@netlify/functions";
import { advanceAll } from "../lib/core.mts";

// Corre a cada minuto no servidor: faz avançar os pedidos mesmo com a app fechada.
export default async (_req: Request) => {
  const open = await advanceAll();
  console.log(`tick: ${open} pedidos em curso`);
};

export const config: Config = { schedule: "* * * * *" };
