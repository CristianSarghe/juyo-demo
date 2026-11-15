-- Demo passwords live only in the backend catalog. Preserve all legacy identity rows and hashes.
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRY
    BEGIN TRANSACTION;
    DECLARE @LockResult int;
    EXEC @LockResult = sys.sp_getapplock
        @Resource = N'juyo_api:migration',
        @LockMode = N'Exclusive',
        @LockOwner = N'Transaction',
        @LockTimeout = 15000;
    IF @LockResult < 0 THROW 51000, 'Could not acquire the API migration lock.', 1;

    IF OBJECT_ID(N'juyo_api.ApiUser', N'U') IS NULL
       OR OBJECT_ID(N'juyo_api.SchemaMigration', N'U') IS NULL
        THROW 51000, 'Apply API migration 001 before migration 002.', 1;
    IF EXISTS (SELECT 1 FROM juyo_api.SchemaMigration WHERE Version = 2)
    BEGIN
        COMMIT TRANSACTION;
        RETURN;
    END;

    ALTER TABLE juyo_api.ApiUser DROP CONSTRAINT CK_ApiUser_PasswordHash;
    ALTER TABLE juyo_api.ApiUser ALTER COLUMN PasswordHash nvarchar(512) NULL;
    ALTER TABLE juyo_api.ApiUser WITH CHECK ADD CONSTRAINT CK_ApiUser_PasswordHash
        CHECK (PasswordHash IS NULL OR LEN(PasswordHash) >= 32);

    INSERT juyo_api.SchemaMigration(Version) VALUES (2);
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
