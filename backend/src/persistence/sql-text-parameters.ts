import sql from 'mssql';

/** Leave headroom for the statement, parameter declarations, and TDS framing. */
export const DIRECT_SQL_TEXT_BYTES = 8_000;
export const SQL_TEXT_CHUNK_CHARACTERS = 2_048;
const TABLE = '#JuyoSqlText';

/** Keep a Unicode pair in the same parameter even when it crosses the chunk boundary. */
export function sqlTextChunks(value: string): string[] {
  if (!value.length) return [''];
  const chunks: string[] = [];
  for (let start = 0; start < value.length; ) {
    let end = Math.min(start + SQL_TEXT_CHUNK_CHARACTERS, value.length);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    )
      end--;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Workerd's SQL transport resets on large Unicode parameters. Stage bounded pieces
 * on the transaction's pinned SQL connection, then assemble the complete value in
 * the final statement so JSON constraints never see a partial document.
 */
export async function withSqlTextParameters<T>(
  tx: sql.Transaction,
  texts: Readonly<Record<string, string | null>>,
  execute: (request: sql.Request, values: Readonly<Record<string, string>>) => Promise<T>,
): Promise<T> {
  const entries = Object.entries(texts);
  if (entries.some(([name]) => !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name)))
    throw new RangeError('SQL text parameter names must be bounded identifiers.');
  const bytes = entries.reduce(
    (total, [, value]) => total + Buffer.byteLength(value ?? '', 'utf16le'),
    0,
  );
  if (bytes <= DIRECT_SQL_TEXT_BYTES) {
    const request = tx.request();
    for (const [name, value] of entries) request.input(name, sql.NVarChar(sql.MAX), value);
    return execute(request, Object.fromEntries(entries.map(([name]) => [name, `@${name}`])));
  }

  // A top-level batch gives #temp connection scope across later sp_executesql calls.
  await tx.request().batch(`CREATE TABLE ${TABLE} (
  Part varchar(32) NOT NULL, Ordinal int NOT NULL, Chunk nvarchar(${SQL_TEXT_CHUNK_CHARACTERS}) NOT NULL,
  PRIMARY KEY (Part, Ordinal));`);
  let succeeded = false;
  try {
    for (const [name, value] of entries) {
      if (value === null) continue;
      const chunks = sqlTextChunks(value);
      for (const [ordinal, chunk] of chunks.entries())
        await tx
          .request()
          .input('part', sql.VarChar(32), name)
          .input('ordinal', sql.Int, ordinal)
          .input('chunk', sql.NVarChar(SQL_TEXT_CHUNK_CHARACTERS), chunk)
          .query(`INSERT ${TABLE}(Part,Ordinal,Chunk) VALUES (@part,@ordinal,@chunk);`);
    }
    const values = Object.fromEntries(
      entries.map(([name]) => [
        name,
        `(SELECT STRING_AGG(CONVERT(nvarchar(max),Chunk),N'') WITHIN GROUP (ORDER BY Ordinal) FROM ${TABLE} WHERE Part='${name}')`,
      ]),
    );
    const result = await execute(tx.request(), values);
    succeeded = true;
    return result;
  } finally {
    try {
      await tx.request().batch(`DROP TABLE ${TABLE};`);
    } catch (error) {
      // XACT_ABORT can already have rolled back the table. Preserve the original failure.
      if (succeeded) throw error;
    }
  }
}
