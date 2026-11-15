#!/usr/bin/env python3
"""Offline SQL Server provisioning. No dependencies or connection to the Angular app."""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parent


def sql_string(value: str) -> str:
    return "N'" + value.replace("'", "''") + "'"


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--trust-server-certificate", action="store_true")
    parser.add_argument("--probe-constraints", action="store_true",
                        help="Exercise invalid writes in rollback-only transactions after verification.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    executable = shutil.which("sqlcmd")
    if not executable:
        parser.error("Install Microsoft's sqlcmd before running this offline tool.")

    # Never accept a password argument or put a connection string in a file.
    password = os.environ.get("JUYO_SQL_PASSWORD") or getpass.getpass("Database password: ")
    environment = os.environ.copy()
    environment["SQLCMDPASSWORD"] = password
    command = [
        executable, "-S", args.server, "-d", args.database, "-U", args.user,
        "-N", "true", "-l", "20", "-t", "180", "-b", "-x", "-I",
        "-h", "-1", "-y", "0", "-w", "65535",
    ]
    if args.trust_server_certificate:
        command.append("-C")

    def execute(*arguments: str, quiet: bool = False) -> str:
        result = subprocess.run(
            [*command, *arguments], env=environment, text=True, capture_output=True,
            encoding="utf-8", errors="replace", timeout=600,
        )
        output = (result.stdout + result.stderr).replace(password, "[redacted]")
        if result.returncode:
            raise RuntimeError(output.strip() or f"sqlcmd exited with {result.returncode}")
        if not quiet and output.strip():
            print(output.strip(), flush=True)
        return output

    def query_json(query: str):
        output = execute("-Q", "SET NOCOUNT ON; " + query, quiet=True)
        # FOR JSON may return several 2,033-character rows. Embedded newlines in
        # string values are JSON-escaped, so only result-row separators disappear.
        return json.loads(output.replace("\r", "").replace("\n", "").strip())

    inspection = query_json("""
        SELECT DB_NAME() AS databaseName,
            CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS serverVersion,
            (SELECT compatibility_level FROM sys.databases WHERE database_id=DB_ID()) AS compatibilityLevel,
            (SELECT COUNT(*) FROM sys.tables) AS userTableCount,
            (SELECT COUNT(*) FROM sys.tables WHERE schema_id=SCHEMA_ID('juyo')) AS managedTableCount
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
    """)
    if inspection["databaseName"] != args.database:
        raise RuntimeError("Connected database does not match the explicitly named target.")
    if inspection["compatibilityLevel"] < 140:
        raise RuntimeError("This migration requires SQL Server compatibility level 140 or newer.")

    existing = query_json("""
        IF OBJECT_ID(N'juyo.SchemaMigration', N'U') IS NULL SELECT N'[]';
        ELSE EXEC(N'SELECT Version, Name, Sha256 FROM juyo.SchemaMigration ORDER BY Version FOR JSON PATH');
    """)
    imports = query_json("""
        IF OBJECT_ID(N'juyo.SourceImport', N'U') IS NULL SELECT N'[]';
        ELSE EXEC(N'SELECT ImportId FROM juyo.SourceImport FOR JSON PATH');
    """)
    migrations = []
    for path in sorted((DIRECTORY / "migrations").glob("[0-9]*.sql")):
        match = re.fullmatch(r"(\d+)_(.+)\.sql", path.name)
        if not match:
            raise RuntimeError(f"Invalid migration name: {path.name}")
        migrations.append((int(match[1]), path.name, file_hash(path), path))
    if not migrations:
        raise RuntimeError("No migration files were found.")
    known = {version: (name, checksum) for version, name, checksum, _ in migrations}
    for row in existing:
        if known.get(row["Version"]) != (row["Name"], row["Sha256"]):
            raise RuntimeError("An applied migration differs from the local version; refusing to overwrite it.")
    if inspection["managedTableCount"] and not existing:
        raise RuntimeError("The juyo schema already contains unmanaged tables; refusing to overwrite them.")

    source = ROOT / "public/data/hotel-network.json"
    source_sha256 = file_hash(source)
    import_ids = {row["ImportId"] for row in imports}
    upgrades = json.loads((DIRECTORY / "fixture-upgrades.json").read_text())
    upgrade = next((row for row in upgrades if row["sourceSha256"] == source_sha256), None)
    permitted_imports = {source_sha256}
    if upgrade:
        permitted_imports.add(upgrade["previousSourceSha256"])
        if upgrade["requiredMigration"] not in known or upgrade["script"] != "extend-hotel-addresses.sql":
            raise RuntimeError("Invalid registered address-only fixture extension.")
    if import_ids - permitted_imports:
        raise RuntimeError("A different fixture import exists. No data will be replaced or deleted.")
    extend_fixture = bool(import_ids and source_sha256 not in import_ids)
    if extend_fixture and (not upgrade or import_ids != {upgrade["previousSourceSha256"]}):
        raise RuntimeError("No exact additive fixture extension matches the imported source.")
    applied = {row["Version"] for row in existing}
    pending = [migration for migration in migrations if migration[0] not in applied]
    if args.verify_only and (pending or not imports or extend_fixture):
        raise RuntimeError("The target has not yet received these migrations and this fixture.")

    generated = DIRECTORY / "generated"
    generated.mkdir(exist_ok=True)
    subprocess.run([sys.executable, str(DIRECTORY / "generate_seed.py")], check=True)
    subprocess.run([sys.executable, str(DIRECTORY / "generate_validation.py")], check=True)
    seed_manifest = json.loads((generated / "seed-manifest.json").read_text())
    validation_sql = (generated / "validate.sql").read_text()
    if (
        file_hash(source) != source_sha256
        or seed_manifest["sourceSha256"] != source_sha256
        or f"-- Source SHA-256: {source_sha256}" not in validation_sql
    ):
        raise RuntimeError("Fixture source changed during preparation; no database changes were made.")
    if any(file_hash(path) != checksum for _, _, checksum, path in migrations):
        raise RuntimeError("A migration changed during preparation; no database changes were made.")
    print(f"Connected to {args.database}; {len(pending)} pending migrations.", flush=True)

    settings = """SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
"""
    with tempfile.TemporaryDirectory(prefix="juyo-database-") as temporary:
        deployment = Path(temporary) / "run.sql"
        lines = [":ON ERROR EXIT", settings, "BEGIN TRANSACTION;"]
        lines.append("""DECLARE @lockResult int;
EXEC @lockResult = sys.sp_getapplock @Resource=N'juyo-offline-provisioning',
    @LockMode=N'Exclusive', @LockOwner=N'Transaction', @LockTimeout=15000;
IF @lockResult < 0 THROW 51000, 'Could not acquire the Juyo migration lock.', 1;
GO
""")
        if args.apply:
            lines.append("""IF SCHEMA_ID(N'juyo') IS NULL EXEC(N'CREATE SCHEMA juyo AUTHORIZATION dbo');
IF OBJECT_ID(N'juyo.SchemaMigration', N'U') IS NULL
BEGIN
    CREATE TABLE juyo.SchemaMigration (
        Version int NOT NULL CONSTRAINT PK_SchemaMigration PRIMARY KEY,
        Name nvarchar(200) NOT NULL,
        Sha256 char(64) NOT NULL,
        AppliedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_SchemaMigration_Applied DEFAULT SYSUTCDATETIME()
    );
END;
GO
""")
            for version, name, checksum, path in pending:
                # Compose one local file: sqlcmd variants parse quoted :r paths
                # differently, especially when workspace paths contain spaces.
                lines.append(path.read_text(encoding="utf-8") + "\nGO\n")
                lines.append(
                    "INSERT juyo.SchemaMigration(Version,Name,Sha256) VALUES "
                    f"({version},{sql_string(name)},{sql_string(checksum)});\nGO\n"
                )
            if not imports:
                lines.append((generated / "seed.sql").read_text(encoding="utf-8") + "\nGO\n")
            elif extend_fixture:
                # This reviewed script contains only new HotelAddress rows and
                # the new import's provenance. Existing facts/history are not
                # updated or deleted, and every collection is checked below.
                lines.append((generated / upgrade["script"]).read_text(encoding="utf-8") + "\nGO\n")
        lines.append(validation_sql + "\nGO\n")
        lines.append("COMMIT TRANSACTION;\nPRINT N'Juyo validation passed; transaction committed.';\nGO\n")
        deployment.write_text("\n".join(lines), encoding="utf-8")
        execute("-i", str(deployment))

    if args.probe_constraints:
        print("Checking enforced constraints with rollback-only probes.", flush=True)
        execute("-i", str(DIRECTORY / "constraint-probes.sql"))

    # A separate connection confirms that the committed objects and import exist.
    counts = query_json("""
        DECLARE @sql nvarchar(max);
        SELECT @sql=STRING_AGG(CAST(N'SELECT N''' + REPLACE(t.name,'''','''''') +
            N''' AS tableName, COUNT_BIG(*) AS [rowCount] FROM juyo.' + QUOTENAME(t.name)
            AS nvarchar(max)),N' UNION ALL ')
        FROM sys.tables t WHERE t.schema_id=SCHEMA_ID(N'juyo');
        SET @sql=N'SELECT * FROM ('+@sql+N') counts ORDER BY tableName FOR JSON PATH';
        EXEC sys.sp_executesql @sql;
    """)
    manifests = query_json("SELECT ImportId FROM juyo.SourceImport FOR JSON PATH;")
    if {row["ImportId"] for row in manifests} != import_ids | {source_sha256}:
        raise RuntimeError("Post-commit source fingerprint verification failed.")
    checks = query_json("""
        SELECT (SELECT COUNT(*) FROM sys.views WHERE schema_id=SCHEMA_ID('juyo')) AS viewCount,
            (SELECT COUNT(*) FROM sys.foreign_keys WHERE schema_id=SCHEMA_ID('juyo')) AS foreignKeyCount,
            (SELECT COUNT(*) FROM sys.check_constraints WHERE schema_id=SCHEMA_ID('juyo')) AS checkConstraintCount,
            (SELECT COUNT(*) FROM sys.triggers WHERE parent_id IN
                (SELECT object_id FROM sys.tables WHERE schema_id=SCHEMA_ID('juyo'))) AS triggerCount
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
    """)
    financial = query_json("""
        SELECT
            (SELECT COUNT_BIG(*) FROM juyo.Hotel) AS hotels,
            (SELECT COUNT_BIG(*) FROM juyo.Room) AS rooms,
            (SELECT COUNT_BIG(*) FROM juyo.Reservation) AS reservations,
            (SELECT COUNT_BIG(*) FROM juyo.ReservationNight) AS acceptedRoomNights,
            CONVERT(varchar(50),(SELECT SUM(RoomRevenue) FROM juyo.ReservationNight)) AS roomRevenueEUR,
            CONVERT(varchar(50),(SELECT SUM(Revenue) FROM juyo.FacilityDailyActivity)) AS ancillaryRevenueEUR,
            CONVERT(varchar(50),(SELECT SUM(Amount) FROM juyo.DailyCost)) AS expensesEUR,
            CONVERT(varchar(50),(SELECT SUM(AcquisitionCost) FROM juyo.DailyChannels)) AS channelAcquisitionEUR
        FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
    """)
    report = {
        "verifiedAtUtc": datetime.now(timezone.utc).isoformat(),
        "server": args.server,
        "database": args.database,
        "serverVersion": inspection["serverVersion"],
        "sourceFile": "public/data/hotel-network.json",
        "sourceSha256": source_sha256,
        "preservedSourceImports": sorted(import_ids - {source_sha256}),
        "fixtureVersion": json.loads(source.read_text())["meta"]["schemaVersion"],
        "mode": "verify-only" if args.verify_only else "apply",
        "encryptedConnection": True,
        "trustServerCertificate": args.trust_server_certificate,
        "migrations": [{"version": v, "name": n, "sha256": h} for v,n,h,_ in migrations],
        "tables": counts,
        **checks,
        "canonicalFieldComparisonsPassed": True,
        "constraintProbesPassed": args.probe_constraints,
        "financialTotals": financial,
        "frontendConnected": False,
    }
    report_path = DIRECTORY / "verification-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Verified {len(counts)} committed tables; report: {report_path}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.SubprocessError, ValueError) as error:
        print(f"Database operation failed: {error}", file=sys.stderr)
        sys.exit(1)
