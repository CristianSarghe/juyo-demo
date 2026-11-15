-- Additive API-owned state. Canonical juyo facts are referenced, never changed.
-- This script owns its transaction and can be repeated after a successful apply.
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

    IF OBJECT_ID(N'juyo.Room', N'U') IS NULL
       OR OBJECT_ID(N'juyo.SourceImport', N'U') IS NULL
        THROW 51000, 'Apply the canonical juyo schema and verified import before the API migration.', 1;

    IF SCHEMA_ID(N'juyo_api') IS NULL EXEC(N'CREATE SCHEMA juyo_api AUTHORIZATION dbo;');
    IF OBJECT_ID(N'juyo_api.SchemaMigration', N'U') IS NULL
        CREATE TABLE juyo_api.SchemaMigration (
            Version int NOT NULL CONSTRAINT PK_ApiSchemaMigration PRIMARY KEY,
            AppliedAt datetime2(3) NOT NULL CONSTRAINT DF_ApiSchemaMigration_AppliedAt DEFAULT SYSUTCDATETIME()
        );
    IF EXISTS (SELECT 1 FROM juyo_api.SchemaMigration WHERE Version = 1)
    BEGIN
        COMMIT TRANSACTION;
        RETURN;
    END;

    CREATE TABLE juyo_api.ApiUser (
        Id uniqueidentifier NOT NULL CONSTRAINT PK_ApiUser PRIMARY KEY,
        Email nvarchar(254) NOT NULL,
        Name nvarchar(100) NOT NULL,
        PasswordHash nvarchar(512) NOT NULL,
        CreatedAt datetime2(3) NOT NULL CONSTRAINT DF_ApiUser_CreatedAt DEFAULT SYSUTCDATETIME(),
        Disabled bit NOT NULL CONSTRAINT DF_ApiUser_Disabled DEFAULT 0,
        CONSTRAINT UQ_ApiUser_Email UNIQUE (Email),
        CONSTRAINT CK_ApiUser_Email CHECK (
            LEN(Email) > 3
            AND Email COLLATE Latin1_General_100_BIN2 =
                LOWER(LTRIM(RTRIM(Email))) COLLATE Latin1_General_100_BIN2
            AND Email LIKE N'%_@_%._%'
        ),
        CONSTRAINT CK_ApiUser_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0),
        CONSTRAINT CK_ApiUser_PasswordHash CHECK (LEN(PasswordHash) >= 32)
    );

    CREATE TABLE juyo_api.ApiSession (
        TokenHash char(64) NOT NULL CONSTRAINT PK_ApiSession PRIMARY KEY,
        UserId uniqueidentifier NOT NULL,
        CreatedAt datetime2(3) NOT NULL CONSTRAINT DF_ApiSession_CreatedAt DEFAULT SYSUTCDATETIME(),
        ExpiresAt datetime2(3) NOT NULL,
        CONSTRAINT FK_ApiSession_User FOREIGN KEY (UserId) REFERENCES juyo_api.ApiUser(Id),
        CONSTRAINT CK_ApiSession_TokenHash CHECK (
            LEN(TokenHash) = 64 AND TokenHash COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^0-9a-f]%'
        ),
        CONSTRAINT CK_ApiSession_Expiry CHECK (ExpiresAt > CreatedAt)
    );
    CREATE INDEX IX_ApiSession_User ON juyo_api.ApiSession(UserId);
    CREATE INDEX IX_ApiSession_Expiry ON juyo_api.ApiSession(ExpiresAt);

    CREATE TABLE juyo_api.RoomOperationChange (
        RoomId varchar(64) NOT NULL,
        StayDate date NOT NULL,
        HousekeepingCode varchar(32) NULL,
        StatusCode varchar(32) NULL,
        AppliedAt datetime2(3) NOT NULL CONSTRAINT DF_RoomOperationChange_AppliedAt DEFAULT SYSUTCDATETIME(),
        AppliedBy uniqueidentifier NOT NULL,
        CONSTRAINT PK_RoomOperationChange PRIMARY KEY (RoomId, StayDate),
        CONSTRAINT FK_RoomOperationChange_Room FOREIGN KEY (RoomId) REFERENCES juyo.Room(RoomId),
        CONSTRAINT FK_RoomOperationChange_Date FOREIGN KEY (StayDate) REFERENCES juyo.CalendarDate([Date]),
        CONSTRAINT FK_RoomOperationChange_Housekeeping FOREIGN KEY (HousekeepingCode) REFERENCES juyo.HousekeepingStatus(Code),
        CONSTRAINT FK_RoomOperationChange_User FOREIGN KEY (AppliedBy) REFERENCES juyo_api.ApiUser(Id),
        CONSTRAINT CK_RoomOperationChange_Status CHECK (StatusCode IN ('available', 'reserved', 'out_of_service')),
        CONSTRAINT CK_RoomOperationChange_NotEmpty CHECK (HousekeepingCode IS NOT NULL OR StatusCode IS NOT NULL)
    );
    CREATE INDEX IX_RoomOperationChange_Date ON juyo_api.RoomOperationChange(StayDate, RoomId);

    CREATE TABLE juyo_api.RoomOperationAudit (
        Id bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_RoomOperationAudit PRIMARY KEY,
        RoomId varchar(64) NOT NULL,
        StayDate date NOT NULL,
        ActionCode varchar(32) NOT NULL,
        HousekeepingCode varchar(32) NULL,
        StatusCode varchar(32) NULL,
        AppliedAt datetime2(3) NOT NULL CONSTRAINT DF_RoomOperationAudit_AppliedAt DEFAULT SYSUTCDATETIME(),
        AppliedBy uniqueidentifier NOT NULL,
        CONSTRAINT FK_RoomOperationAudit_Room FOREIGN KEY (RoomId) REFERENCES juyo.Room(RoomId),
        CONSTRAINT FK_RoomOperationAudit_Date FOREIGN KEY (StayDate) REFERENCES juyo.CalendarDate([Date]),
        CONSTRAINT FK_RoomOperationAudit_Housekeeping FOREIGN KEY (HousekeepingCode) REFERENCES juyo.HousekeepingStatus(Code),
        CONSTRAINT FK_RoomOperationAudit_User FOREIGN KEY (AppliedBy) REFERENCES juyo_api.ApiUser(Id),
        CONSTRAINT CK_RoomOperationAudit_Action CHECK (ActionCode IN ('clean','dirty','reserve','out_of_service','available','reset','replace')),
        CONSTRAINT CK_RoomOperationAudit_Status CHECK (StatusCode IN ('available','reserved','out_of_service'))
    );
    CREATE INDEX IX_RoomOperationAudit_RoomDate ON juyo_api.RoomOperationAudit(RoomId, StayDate, Id);

    -- HotelId is derived from RoomTypeId, rather than duplicated in every update.
    CREATE TABLE juyo_api.RateUpdate (
        Id uniqueidentifier NOT NULL CONSTRAINT PK_RateUpdate PRIMARY KEY NONCLUSTERED,
        AppliedSequence bigint IDENTITY(1,1) NOT NULL CONSTRAINT UQ_RateUpdate_Sequence UNIQUE CLUSTERED,
        RoomTypeId varchar(64) NOT NULL,
        StartDate date NOT NULL,
        EndDate date NOT NULL,
        NightlyRate decimal(19,2) NOT NULL,
        EventId varchar(64) NULL,
        Reason nvarchar(240) NULL,
        AppliedAt datetime2(3) NOT NULL CONSTRAINT DF_RateUpdate_AppliedAt DEFAULT SYSUTCDATETIME(),
        AppliedBy uniqueidentifier NOT NULL,
        CONSTRAINT FK_RateUpdate_RoomType FOREIGN KEY (RoomTypeId) REFERENCES juyo.RoomType(RoomTypeId),
        CONSTRAINT FK_RateUpdate_StartDate FOREIGN KEY (StartDate) REFERENCES juyo.CalendarDate([Date]),
        CONSTRAINT FK_RateUpdate_EndDate FOREIGN KEY (EndDate) REFERENCES juyo.CalendarDate([Date]),
        CONSTRAINT FK_RateUpdate_Event FOREIGN KEY (EventId) REFERENCES juyo.HotelEvent(EventId),
        CONSTRAINT FK_RateUpdate_User FOREIGN KEY (AppliedBy) REFERENCES juyo_api.ApiUser(Id),
        CONSTRAINT CK_RateUpdate_Interval CHECK (StartDate <= EndDate),
        CONSTRAINT CK_RateUpdate_Rate CHECK (NightlyRate >= 0.01 AND NightlyRate <= 10000),
        CONSTRAINT CK_RateUpdate_Reason CHECK (Reason IS NULL OR LEN(LTRIM(RTRIM(Reason))) > 0)
    );
    CREATE INDEX IX_RateUpdate_RoomTypeDates ON juyo_api.RateUpdate(RoomTypeId, StartDate, EndDate, AppliedSequence);
    CREATE INDEX IX_RateUpdate_User ON juyo_api.RateUpdate(AppliedBy);

    CREATE TABLE juyo_api.Conversation (
        Id uniqueidentifier NOT NULL CONSTRAINT PK_ApiConversation PRIMARY KEY,
        UserId uniqueidentifier NOT NULL,
        Title nvarchar(100) NOT NULL,
        HotelId varchar(64) NULL,
        ReportingMonth char(7) NOT NULL,
        RoomDate date NOT NULL,
        DataVersion varchar(32) NULL,
        CreatedAt datetime2(3) NOT NULL CONSTRAINT DF_ApiConversation_CreatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedAt datetime2(3) NOT NULL CONSTRAINT DF_ApiConversation_UpdatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_ApiConversation_User FOREIGN KEY (UserId) REFERENCES juyo_api.ApiUser(Id),
        CONSTRAINT FK_ApiConversation_Hotel FOREIGN KEY (HotelId) REFERENCES juyo.Hotel(HotelId),
        CONSTRAINT FK_ApiConversation_Date FOREIGN KEY (RoomDate) REFERENCES juyo.CalendarDate([Date]),
        CONSTRAINT CK_ApiConversation_Title CHECK (LEN(LTRIM(RTRIM(Title))) > 0),
        CONSTRAINT CK_ApiConversation_Month CHECK (
            ReportingMonth LIKE '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
            AND TRY_CONVERT(date, ReportingMonth + '-01', 23) IS NOT NULL
        ),
        CONSTRAINT CK_ApiConversation_UpdatedAt CHECK (UpdatedAt >= CreatedAt)
    );
    CREATE INDEX IX_ApiConversation_UserUpdated ON juyo_api.Conversation(UserId, UpdatedAt DESC, Id);

    CREATE TABLE juyo_api.Message (
        Id uniqueidentifier NOT NULL CONSTRAINT PK_ApiMessage PRIMARY KEY,
        ConversationId uniqueidentifier NOT NULL,
        Ordinal int NOT NULL,
        RoleCode varchar(16) NOT NULL,
        Content nvarchar(max) NOT NULL,
        InsightJson nvarchar(max) NULL,
        CreatedAt datetime2(3) NOT NULL CONSTRAINT DF_ApiMessage_CreatedAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT FK_ApiMessage_Conversation FOREIGN KEY (ConversationId) REFERENCES juyo_api.Conversation(Id),
        CONSTRAINT UQ_ApiMessage_Ordinal UNIQUE (ConversationId, Ordinal),
        CONSTRAINT CK_ApiMessage_Ordinal CHECK (Ordinal >= 1),
        CONSTRAINT CK_ApiMessage_Role CHECK (RoleCode IN ('user','assistant')),
        CONSTRAINT CK_ApiMessage_ContentLength CHECK (DATALENGTH(Content) <= 20000),
        CONSTRAINT CK_ApiMessage_Insight CHECK (
            InsightJson IS NULL OR (
                ISJSON(InsightJson) = 1
                AND LEFT(LTRIM(InsightJson), 1) = N'{'
                AND DATALENGTH(InsightJson) <= 262144
            )
        )
    );

    INSERT juyo_api.SchemaMigration(Version) VALUES (1);
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
