export interface ApiEnvironment {
  SQL_SERVER: string;
  SQL_DATABASE: string;
  SQL_USER: string;
  SQL_PASSWORD: string;
  SQL_PORT?: string;
  SQL_TRUST_CERTIFICATE?: string;
  ALLOWED_ORIGINS?: string;
  PORT?: string;
  /** Separate, removable inference/MCP Worker. No model key belongs in Angular. */
  KASSANDRA_URL?: string;
}

export function readEnvironment(source: NodeJS.ProcessEnv = process.env): ApiEnvironment {
  const required = ['SQL_SERVER', 'SQL_DATABASE', 'SQL_USER', 'SQL_PASSWORD'] as const;
  for (const key of required) {
    if (!source[key]) throw new Error(`Missing required server environment variable: ${key}`);
  }
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as unknown as ApiEnvironment;
}

export function allowedOrigins(env: ApiEnvironment): Set<string> {
  return new Set(
    (env.ALLOWED_ORIGINS ??
      'http://127.0.0.1:4200,http://localhost:4200,http://127.0.0.1:4201,http://localhost:4201')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}
