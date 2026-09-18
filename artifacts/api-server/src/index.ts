import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty } from "./lib/seed";

const rawPort = process.env["PORT"] || process.env["API_PORT"] ||
  (process.env.NODE_ENV !== "production" ? "3000" : undefined);

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

try {
  await seedIfEmpty();
} catch (err) {
  // Sem os dados (ou sem a conversão para o modelo dimensional) toda leitura
  // do bridge falharia — melhor não subir do que servir erros.
  logger.error({ err }, "Falha ao importar/converter dados iniciais do bridge — abortando");
  process.exit(1);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
