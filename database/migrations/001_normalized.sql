-- Normalized hotel-network model. The caller owns the transaction and migration history.
-- Required for indexed join views and all subsequent writes in this connection.
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
SET XACT_ABORT ON;
GO

IF SCHEMA_ID(N'juyo') IS NULL EXEC(N'CREATE SCHEMA juyo AUTHORIZATION dbo;');
GO

CREATE TABLE juyo.AmountBasis (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_AmountBasis PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_AmountBasis_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_AmountBasis_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.HotelStatus (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_HotelStatus PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_HotelStatus_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_HotelStatus_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.HotelCategory (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_HotelCategory PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_HotelCategory_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_HotelCategory_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.HousekeepingStatus (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_HousekeepingStatus PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_HousekeepingStatus_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_HousekeepingStatus_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.MaintenanceStatus (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_MaintenanceStatus PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_MaintenanceStatus_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_MaintenanceStatus_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.RoomStateBasis (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_RoomStateBasis PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_RoomStateBasis_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_RoomStateBasis_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.RoomAmenity (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_RoomAmenity PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_RoomAmenity_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_RoomAmenity_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.FacilityKind (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_FacilityKind PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_FacilityKind_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_FacilityKind_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.FeeUnit (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_FeeUnit PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_FeeUnit_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_FeeUnit_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.CostCategory (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_CostCategory PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_CostCategory_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_CostCategory_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.Department (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_Department PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_Department_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_Department_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.CostBasis (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_CostBasis PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_CostBasis_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_CostBasis_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.UnitCostBasis (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_UnitCostBasis PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_UnitCostBasis_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_UnitCostBasis_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.ActivityBasis (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_ActivityBasis PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_ActivityBasis_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_ActivityBasis_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.ReservationStatus (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_ReservationStatus PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_ReservationStatus_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_ReservationStatus_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.EventCategory (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_EventCategory PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_EventCategory_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_EventCategory_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.EventImportance (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_EventImportance PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_EventImportance_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_EventImportance_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.AssessmentSource (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_AssessmentSource PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_AssessmentSource_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_AssessmentSource_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.BookingChannel (
    Code varchar(32) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CommissionRate decimal(9,6) NOT NULL,
    CONSTRAINT PK_BookingChannel PRIMARY KEY CLUSTERED (Code),
    CONSTRAINT CK_BookingChannel_Code CHECK (LEN(LTRIM(RTRIM(Code))) > 0),
    CONSTRAINT CK_BookingChannel_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0),
    CONSTRAINT CK_BookingChannel_Rate CHECK (CommissionRate >= 0 AND CommissionRate <= 1)
);
GO

CREATE TABLE juyo.Currency (
    CurrencyCode char(3) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_Currency PRIMARY KEY CLUSTERED (CurrencyCode),
    CONSTRAINT CK_Currency_Code CHECK (CurrencyCode COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^A-Z]%' AND LEN(CurrencyCode) = 3)
);
GO

CREATE TABLE juyo.Organization (
    OrganizationId varchar(64) NOT NULL,
    Name nvarchar(200) NOT NULL,
    ReportingCurrencyCode char(3) NOT NULL,
    AmountBasisCode varchar(32) NOT NULL,
    CONSTRAINT PK_Organization PRIMARY KEY CLUSTERED (OrganizationId),
    CONSTRAINT FK_Organization_Currency FOREIGN KEY (ReportingCurrencyCode) REFERENCES juyo.Currency(CurrencyCode),
    CONSTRAINT FK_Organization_AmountBasis FOREIGN KEY (AmountBasisCode) REFERENCES juyo.AmountBasis(Code),
    CONSTRAINT CK_Organization_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.SourceImport (
    ImportId char(64) NOT NULL,
    OrganizationId varchar(64) NOT NULL,
    SchemaVersion varchar(32) NOT NULL,
    IsTestData bit NOT NULL,
    AmountBasis varchar(32) NOT NULL,
    PeriodStartDate date NOT NULL,
    PeriodEndDate date NOT NULL,
    AsOfDate date NOT NULL,
    PreviousAsOfDate date NOT NULL,
    BookingSource varchar(100) NOT NULL,
    ImportedAtUtc datetime2(3) NOT NULL CONSTRAINT DF_SourceImport_ImportedAtUtc DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_SourceImport PRIMARY KEY CLUSTERED (ImportId),
    CONSTRAINT FK_SourceImport_Organization FOREIGN KEY (OrganizationId) REFERENCES juyo.Organization(OrganizationId),
    CONSTRAINT FK_SourceImport_AmountBasis FOREIGN KEY (AmountBasis) REFERENCES juyo.AmountBasis(Code),
    CONSTRAINT CK_SourceImport_Hash CHECK (LEN(ImportId) = 64 AND ImportId NOT LIKE '%[^0-9a-f]%'),
    CONSTRAINT CK_SourceImport_Period CHECK (PeriodStartDate <= PeriodEndDate),
    CONSTRAINT CK_SourceImport_Snapshots CHECK (PreviousAsOfDate < AsOfDate)
);
GO

CREATE TABLE juyo.SourceImportNote (
    ImportId char(64) NOT NULL,
    NoteKind varchar(32) NOT NULL,
    Ordinal smallint NOT NULL,
    NoteText nvarchar(4000) NOT NULL,
    CONSTRAINT PK_SourceImportNote PRIMARY KEY CLUSTERED (ImportId, NoteKind, Ordinal),
    CONSTRAINT FK_SourceImportNote_Import FOREIGN KEY (ImportId) REFERENCES juyo.SourceImport(ImportId),
    CONSTRAINT CK_SourceImportNote_Ordinal CHECK (Ordinal >= 1),
    CONSTRAINT CK_SourceImportNote_Text CHECK (LEN(LTRIM(RTRIM(NoteText))) > 0)
);
GO

CREATE TABLE juyo.SourceSnapshotStatusPolicy (
    ImportId char(64) NOT NULL,
    StatusCode varchar(32) NOT NULL,
    IsIncludedOnBooks bit NOT NULL,
    CONSTRAINT PK_SourceSnapshotStatusPolicy PRIMARY KEY CLUSTERED (ImportId, StatusCode),
    CONSTRAINT FK_SourceSnapshotStatusPolicy_Import FOREIGN KEY (ImportId) REFERENCES juyo.SourceImport(ImportId),
    CONSTRAINT FK_SourceSnapshotStatusPolicy_Status FOREIGN KEY (StatusCode) REFERENCES juyo.ReservationStatus(Code)
);
GO

CREATE TABLE juyo.CalendarDate (
    [Date] date NOT NULL,
    CONSTRAINT PK_CalendarDate PRIMARY KEY CLUSTERED ([Date])
);
GO

CREATE TABLE juyo.Country (
    CountryCode char(2) NOT NULL,
    Name nvarchar(100) NOT NULL,
    CONSTRAINT PK_Country PRIMARY KEY CLUSTERED (CountryCode),
    CONSTRAINT UQ_Country_Name UNIQUE (Name),
    CONSTRAINT CK_Country_Code CHECK (CountryCode COLLATE Latin1_General_100_BIN2 NOT LIKE '%[^A-Z]%' AND LEN(CountryCode) = 2)
);
GO

CREATE TABLE juyo.City (
    CityId varchar(64) NOT NULL,
    CountryCode char(2) NOT NULL,
    Name nvarchar(150) NOT NULL,
    CONSTRAINT PK_City PRIMARY KEY CLUSTERED (CityId),
    CONSTRAINT FK_City_Country FOREIGN KEY (CountryCode) REFERENCES juyo.Country(CountryCode),
    CONSTRAINT UQ_City_CountryName UNIQUE (CountryCode, Name),
    CONSTRAINT CK_City_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0)
);
GO

CREATE TABLE juyo.TimeZone (
    TimeZoneId varchar(64) NOT NULL,
    CONSTRAINT PK_TimeZone PRIMARY KEY CLUSTERED (TimeZoneId),
    CONSTRAINT CK_TimeZone_Id CHECK (LEN(LTRIM(RTRIM(TimeZoneId))) > 0)
);
GO

CREATE TABLE juyo.Hotel (
    HotelId varchar(64) NOT NULL,
    OrganizationId varchar(64) NOT NULL,
    CityId varchar(64) NOT NULL,
    TimeZoneId varchar(64) NOT NULL,
    Name nvarchar(200) NOT NULL,
    StatusCode varchar(32) NOT NULL,
    CategoryCode varchar(32) NOT NULL,
    StarRating tinyint NOT NULL,
    OpenedYear smallint NOT NULL,
    Latitude decimal(9,6) NOT NULL,
    Longitude decimal(9,6) NOT NULL,
    CurrencyCode char(3) NOT NULL,
    CONSTRAINT PK_Hotel PRIMARY KEY CLUSTERED (HotelId),
    CONSTRAINT FK_Hotel_Organization FOREIGN KEY (OrganizationId) REFERENCES juyo.Organization(OrganizationId),
    CONSTRAINT FK_Hotel_City FOREIGN KEY (CityId) REFERENCES juyo.City(CityId),
    CONSTRAINT FK_Hotel_TimeZone FOREIGN KEY (TimeZoneId) REFERENCES juyo.TimeZone(TimeZoneId),
    CONSTRAINT FK_Hotel_Status FOREIGN KEY (StatusCode) REFERENCES juyo.HotelStatus(Code),
    CONSTRAINT FK_Hotel_Category FOREIGN KEY (CategoryCode) REFERENCES juyo.HotelCategory(Code),
    CONSTRAINT FK_Hotel_Currency FOREIGN KEY (CurrencyCode) REFERENCES juyo.Currency(CurrencyCode),
    CONSTRAINT CK_Hotel_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0),
    CONSTRAINT CK_Hotel_Stars CHECK (StarRating BETWEEN 1 AND 5),
    CONSTRAINT CK_Hotel_OpenedYear CHECK (OpenedYear BETWEEN 1000 AND 9999),
    CONSTRAINT CK_Hotel_Coordinates CHECK (Latitude BETWEEN -90 AND 90 AND Longitude BETWEEN -180 AND 180)
);
CREATE INDEX IX_Hotel_Organization ON juyo.Hotel(OrganizationId);
CREATE INDEX IX_Hotel_City ON juyo.Hotel(CityId);
GO

CREATE TABLE juyo.RoomType (
    RoomTypeId varchar(64) NOT NULL,
    HotelId varchar(64) NOT NULL,
    Name nvarchar(100) NOT NULL,
    MaxAdults smallint NOT NULL,
    MaxChildren smallint NOT NULL,
    AreaM2 decimal(9,2) NOT NULL,
    BaseRate decimal(19,2) NOT NULL,
    CONSTRAINT PK_RoomType PRIMARY KEY CLUSTERED (RoomTypeId),
    CONSTRAINT FK_RoomType_Hotel FOREIGN KEY (HotelId) REFERENCES juyo.Hotel(HotelId),
    CONSTRAINT UQ_RoomType_HotelName UNIQUE (HotelId, Name),
    CONSTRAINT CK_RoomType_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0),
    CONSTRAINT CK_RoomType_Capacity CHECK (MaxAdults >= 1 AND MaxChildren >= 0),
    CONSTRAINT CK_RoomType_Area CHECK (AreaM2 > 0),
    CONSTRAINT CK_RoomType_BaseRate CHECK (BaseRate > 0)
);
GO

CREATE TABLE juyo.RoomTypeAmenity (
    RoomTypeId varchar(64) NOT NULL,
    AmenityCode varchar(32) NOT NULL,
    CONSTRAINT PK_RoomTypeAmenity PRIMARY KEY CLUSTERED (RoomTypeId, AmenityCode),
    CONSTRAINT FK_RoomTypeAmenity_RoomType FOREIGN KEY (RoomTypeId) REFERENCES juyo.RoomType(RoomTypeId),
    CONSTRAINT FK_RoomTypeAmenity_Amenity FOREIGN KEY (AmenityCode) REFERENCES juyo.RoomAmenity(Code)
);
GO

CREATE TABLE juyo.Room (
    RoomId varchar(64) NOT NULL,
    RoomTypeId varchar(64) NOT NULL,
    [Number] varchar(16) NOT NULL,
    Floor smallint NOT NULL,
    CONSTRAINT PK_Room PRIMARY KEY CLUSTERED (RoomId),
    CONSTRAINT FK_Room_RoomType FOREIGN KEY (RoomTypeId) REFERENCES juyo.RoomType(RoomTypeId),
    CONSTRAINT CK_Room_Number CHECK (LEN(LTRIM(RTRIM([Number]))) > 0)
);
CREATE INDEX IX_Room_RoomType ON juyo.Room(RoomTypeId);
GO

CREATE TABLE juyo.RoomDailyState (
    RoomId varchar(64) NOT NULL,
    StayDate date NOT NULL,
    IsOutOfService bit NOT NULL,
    HousekeepingCode varchar(32) NOT NULL,
    MaintenanceCode varchar(32) NOT NULL,
    MaintenanceNote nvarchar(1000) NULL,
    BasisCode varchar(32) NOT NULL,
    CONSTRAINT PK_RoomDailyState PRIMARY KEY CLUSTERED (RoomId, StayDate),
    CONSTRAINT FK_RoomDailyState_Room FOREIGN KEY (RoomId) REFERENCES juyo.Room(RoomId),
    CONSTRAINT FK_RoomDailyState_Date FOREIGN KEY (StayDate) REFERENCES juyo.CalendarDate([Date]),
    CONSTRAINT FK_RoomDailyState_Housekeeping FOREIGN KEY (HousekeepingCode) REFERENCES juyo.HousekeepingStatus(Code),
    CONSTRAINT FK_RoomDailyState_Maintenance FOREIGN KEY (MaintenanceCode) REFERENCES juyo.MaintenanceStatus(Code),
    CONSTRAINT FK_RoomDailyState_Basis FOREIGN KEY (BasisCode) REFERENCES juyo.RoomStateBasis(Code),
    CONSTRAINT CK_RoomDailyState_Maintenance CHECK (
        (MaintenanceCode = 'none' AND MaintenanceNote IS NULL)
        OR (MaintenanceCode <> 'none' AND MaintenanceNote IS NOT NULL AND LEN(LTRIM(RTRIM(MaintenanceNote))) > 0)
    )
);
CREATE INDEX IX_RoomDailyState_Date ON juyo.RoomDailyState(StayDate, RoomId) INCLUDE (IsOutOfService, HousekeepingCode, BasisCode);
GO

CREATE TABLE juyo.RoomDailyRate (
    RoomTypeId varchar(64) NOT NULL,
    StayDate date NOT NULL,
    NightlyRate decimal(19,2) NOT NULL,
    CONSTRAINT PK_RoomDailyRate PRIMARY KEY CLUSTERED (RoomTypeId, StayDate),
    CONSTRAINT FK_RoomDailyRate_RoomType FOREIGN KEY (RoomTypeId) REFERENCES juyo.RoomType(RoomTypeId),
    CONSTRAINT FK_RoomDailyRate_Date FOREIGN KEY (StayDate) REFERENCES juyo.CalendarDate([Date]),
    CONSTRAINT CK_RoomDailyRate_Amount CHECK (NightlyRate > 0)
);
CREATE INDEX IX_RoomDailyRate_Date ON juyo.RoomDailyRate(StayDate, RoomTypeId);
GO

CREATE TABLE juyo.Facility (
    FacilityId varchar(64) NOT NULL,
    HotelId varchar(64) NOT NULL,
    KindCode varchar(32) NOT NULL,
    Name nvarchar(200) NOT NULL,
    Capacity int NULL,
    Fee decimal(19,2) NOT NULL,
    FeeUnitCode varchar(32) NOT NULL,
    CONSTRAINT PK_Facility PRIMARY KEY CLUSTERED (FacilityId),
    CONSTRAINT FK_Facility_Hotel FOREIGN KEY (HotelId) REFERENCES juyo.Hotel(HotelId),
    CONSTRAINT FK_Facility_Kind FOREIGN KEY (KindCode) REFERENCES juyo.FacilityKind(Code),
    CONSTRAINT FK_Facility_FeeUnit FOREIGN KEY (FeeUnitCode) REFERENCES juyo.FeeUnit(Code),
    CONSTRAINT CK_Facility_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0),
    CONSTRAINT CK_Facility_Capacity CHECK (Capacity IS NULL OR Capacity > 0),
    CONSTRAINT CK_Facility_Fee CHECK (Fee >= 0 AND (FeeUnitCode <> 'included' OR Fee = 0))
);
CREATE INDEX IX_Facility_Hotel ON juyo.Facility(HotelId);
GO

CREATE TABLE juyo.FacilityOpeningWindow (
    FacilityId varchar(64) NOT NULL,
    [Sequence] smallint NOT NULL,
    OpensAt time(0) NOT NULL,
    ClosesAt time(0) NOT NULL,
    EndsNextDay bit NOT NULL,
    CONSTRAINT PK_FacilityOpeningWindow PRIMARY KEY CLUSTERED (FacilityId, [Sequence]),
    CONSTRAINT FK_FacilityOpeningWindow_Facility FOREIGN KEY (FacilityId) REFERENCES juyo.Facility(FacilityId),
    CONSTRAINT CK_FacilityOpeningWindow_Sequence CHECK ([Sequence] >= 1),
    CONSTRAINT CK_FacilityOpeningWindow_Duration CHECK (
        (EndsNextDay = 0 AND ClosesAt > OpensAt) OR (EndsNextDay = 1 AND ClosesAt <= OpensAt)
    )
);
GO

CREATE TABLE juyo.Restaurant (
    FacilityId varchar(64) NOT NULL,
    Cuisine nvarchar(200) NOT NULL,
    BreakfastPrice decimal(19,2) NOT NULL,
    AverageCheck decimal(19,2) NOT NULL,
    CONSTRAINT PK_Restaurant PRIMARY KEY CLUSTERED (FacilityId),
    CONSTRAINT FK_Restaurant_Facility FOREIGN KEY (FacilityId) REFERENCES juyo.Facility(FacilityId),
    CONSTRAINT CK_Restaurant_Prices CHECK (BreakfastPrice >= 0 AND AverageCheck >= 0),
    CONSTRAINT CK_Restaurant_Cuisine CHECK (LEN(LTRIM(RTRIM(Cuisine))) > 0)
);
GO

CREATE TABLE juyo.FacilityDailyActivity (
    FacilityId varchar(64) NOT NULL,
    StayDate date NOT NULL,
    Uses int NOT NULL,
    Revenue decimal(19,2) NOT NULL,
    BasisCode varchar(32) NOT NULL,
    CONSTRAINT PK_FacilityDailyActivity PRIMARY KEY CLUSTERED (FacilityId, StayDate),
    CONSTRAINT FK_FacilityDailyActivity_Facility FOREIGN KEY (FacilityId) REFERENCES juyo.Facility(FacilityId),
    CONSTRAINT FK_FacilityDailyActivity_Date FOREIGN KEY (StayDate) REFERENCES juyo.CalendarDate([Date]),
    CONSTRAINT FK_FacilityDailyActivity_Basis FOREIGN KEY (BasisCode) REFERENCES juyo.ActivityBasis(Code),
    CONSTRAINT CK_FacilityDailyActivity_Amounts CHECK (Uses >= 0 AND Revenue >= 0)
);
CREATE INDEX IX_FacilityDailyActivity_Date ON juyo.FacilityDailyActivity(StayDate, FacilityId);
GO

CREATE TABLE juyo.Reservation (
    ReservationId varchar(64) NOT NULL,
    RoomTypeId varchar(64) NOT NULL,
    GuestReference varchar(64) NOT NULL,
    ChannelCode varchar(32) NOT NULL,
    StatusCode varchar(32) NOT NULL,
    ArrivalDate date NOT NULL,
    DepartureDate date NOT NULL,
    Adults smallint NOT NULL,
    Children smallint NOT NULL,
    BookedOn date NOT NULL,
    CancelledOn date NULL,
    QuotedNightlyRate decimal(19,2) NOT NULL,
    CONSTRAINT PK_Reservation PRIMARY KEY CLUSTERED (ReservationId),
    CONSTRAINT FK_Reservation_RoomType FOREIGN KEY (RoomTypeId) REFERENCES juyo.RoomType(RoomTypeId),
    CONSTRAINT FK_Reservation_Channel FOREIGN KEY (ChannelCode) REFERENCES juyo.BookingChannel(Code),
    CONSTRAINT FK_Reservation_Status FOREIGN KEY (StatusCode) REFERENCES juyo.ReservationStatus(Code),
    CONSTRAINT CK_Reservation_Guest CHECK (LEN(LTRIM(RTRIM(GuestReference))) > 0),
    CONSTRAINT CK_Reservation_Stay CHECK (ArrivalDate < DepartureDate AND BookedOn <= ArrivalDate),
    CONSTRAINT CK_Reservation_Party CHECK (Adults >= 1 AND Children >= 0),
    CONSTRAINT CK_Reservation_Quote CHECK (QuotedNightlyRate >= 0),
    CONSTRAINT CK_Reservation_Cancellation CHECK (
        (StatusCode = 'cancelled' AND CancelledOn IS NOT NULL AND CancelledOn >= BookedOn)
        OR (StatusCode <> 'cancelled' AND CancelledOn IS NULL)
    )
);
CREATE INDEX IX_Reservation_RoomTypeStay ON juyo.Reservation(RoomTypeId, ArrivalDate, DepartureDate) INCLUDE (StatusCode, ChannelCode, BookedOn);
CREATE INDEX IX_Reservation_Channel ON juyo.Reservation(ChannelCode);
CREATE INDEX IX_Reservation_Status ON juyo.Reservation(StatusCode);
GO

CREATE TABLE juyo.ReservationRoomAssignment (
    ReservationId varchar(64) NOT NULL,
    RoomId varchar(64) NOT NULL,
    CONSTRAINT PK_ReservationRoomAssignment PRIMARY KEY CLUSTERED (ReservationId),
    CONSTRAINT FK_ReservationRoomAssignment_Reservation FOREIGN KEY (ReservationId) REFERENCES juyo.Reservation(ReservationId),
    CONSTRAINT FK_ReservationRoomAssignment_Room FOREIGN KEY (RoomId) REFERENCES juyo.Room(RoomId)
);
CREATE INDEX IX_ReservationRoomAssignment_Room ON juyo.ReservationRoomAssignment(RoomId, ReservationId);
GO

CREATE TABLE juyo.ReservationNight (
    ReservationId varchar(64) NOT NULL,
    StayDate date NOT NULL,
    RoomRevenue decimal(19,2) NOT NULL,
    CONSTRAINT PK_ReservationNight PRIMARY KEY CLUSTERED (ReservationId, StayDate),
    CONSTRAINT FK_ReservationNight_Assignment FOREIGN KEY (ReservationId) REFERENCES juyo.ReservationRoomAssignment(ReservationId),
    CONSTRAINT FK_ReservationNight_Date FOREIGN KEY (StayDate) REFERENCES juyo.CalendarDate([Date]),
    CONSTRAINT CK_ReservationNight_Revenue CHECK (RoomRevenue >= 0)
);
CREATE INDEX IX_ReservationNight_Date ON juyo.ReservationNight(StayDate, ReservationId) INCLUDE (RoomRevenue);
GO

CREATE TABLE juyo.CostAccount (
    CostAccountId varchar(64) NOT NULL,
    CategoryCode varchar(32) NOT NULL,
    DepartmentCode varchar(32) NOT NULL,
    Description nvarchar(500) NOT NULL,
    CONSTRAINT PK_CostAccount PRIMARY KEY CLUSTERED (CostAccountId),
    CONSTRAINT FK_CostAccount_Category FOREIGN KEY (CategoryCode) REFERENCES juyo.CostCategory(Code),
    CONSTRAINT FK_CostAccount_Department FOREIGN KEY (DepartmentCode) REFERENCES juyo.Department(Code),
    CONSTRAINT UQ_CostAccount_Identity UNIQUE (CategoryCode, DepartmentCode, Description),
    CONSTRAINT CK_CostAccount_Description CHECK (LEN(LTRIM(RTRIM(Description))) > 0)
);
GO

CREATE TABLE juyo.DailyCost (
    CostEntryId varchar(64) NOT NULL,
    HotelId varchar(64) NOT NULL,
    StayDate date NOT NULL,
    CostAccountId varchar(64) NOT NULL,
    Amount decimal(19,2) NOT NULL,
    BasisCode varchar(32) NOT NULL,
    CONSTRAINT PK_DailyCost PRIMARY KEY CLUSTERED (CostEntryId),
    CONSTRAINT FK_DailyCost_Hotel FOREIGN KEY (HotelId) REFERENCES juyo.Hotel(HotelId),
    CONSTRAINT FK_DailyCost_Date FOREIGN KEY (StayDate) REFERENCES juyo.CalendarDate([Date]),
    CONSTRAINT FK_DailyCost_Account FOREIGN KEY (CostAccountId) REFERENCES juyo.CostAccount(CostAccountId),
    CONSTRAINT FK_DailyCost_Basis FOREIGN KEY (BasisCode) REFERENCES juyo.CostBasis(Code),
    CONSTRAINT UQ_DailyCost_Grain UNIQUE (HotelId, StayDate, CostAccountId, BasisCode),
    CONSTRAINT CK_DailyCost_Amount CHECK (Amount >= 0)
);
CREATE INDEX IX_DailyCost_Account ON juyo.DailyCost(CostAccountId, StayDate);
CREATE INDEX IX_DailyCost_Date ON juyo.DailyCost(StayDate, HotelId) INCLUDE (Amount, BasisCode);
GO

CREATE TABLE juyo.UnitCost (
    UnitCostId varchar(64) NOT NULL,
    HotelId varchar(64) NOT NULL,
    BasisCode varchar(32) NOT NULL,
    Amount decimal(19,2) NOT NULL,
    Description nvarchar(500) NOT NULL,
    CONSTRAINT PK_UnitCost PRIMARY KEY CLUSTERED (UnitCostId),
    CONSTRAINT FK_UnitCost_Hotel FOREIGN KEY (HotelId) REFERENCES juyo.Hotel(HotelId),
    CONSTRAINT FK_UnitCost_Basis FOREIGN KEY (BasisCode) REFERENCES juyo.UnitCostBasis(Code),
    CONSTRAINT UQ_UnitCost_HotelBasis UNIQUE (HotelId, BasisCode),
    CONSTRAINT CK_UnitCost_Amount CHECK (Amount >= 0)
);
GO

CREATE TABLE juyo.HotelDailyTarget (
    HotelId varchar(64) NOT NULL,
    StayDate date NOT NULL,
    TargetRooms int NOT NULL,
    TargetRevenue decimal(19,2) NOT NULL,
    CONSTRAINT PK_HotelDailyTarget PRIMARY KEY CLUSTERED (HotelId, StayDate),
    CONSTRAINT FK_HotelDailyTarget_Hotel FOREIGN KEY (HotelId) REFERENCES juyo.Hotel(HotelId),
    CONSTRAINT FK_HotelDailyTarget_Date FOREIGN KEY (StayDate) REFERENCES juyo.CalendarDate([Date]),
    CONSTRAINT CK_HotelDailyTarget_Values CHECK (TargetRooms >= 0 AND TargetRevenue >= 0)
);
CREATE INDEX IX_HotelDailyTarget_Date ON juyo.HotelDailyTarget(StayDate, HotelId);
GO

CREATE TABLE juyo.BookingPositionSnapshot (
    HotelId varchar(64) NOT NULL,
    StayDate date NOT NULL,
    CapturedAsOf date NOT NULL,
    RoomsAvailable int NULL,
    RoomCount int NOT NULL,
    RoomRevenue decimal(19,2) NOT NULL,
    CONSTRAINT PK_BookingPositionSnapshot PRIMARY KEY CLUSTERED (HotelId, StayDate, CapturedAsOf),
    CONSTRAINT FK_BookingPositionSnapshot_Hotel FOREIGN KEY (HotelId) REFERENCES juyo.Hotel(HotelId),
    CONSTRAINT FK_BookingPositionSnapshot_Date FOREIGN KEY (StayDate) REFERENCES juyo.CalendarDate([Date]),
    CONSTRAINT CK_BookingPositionSnapshot_Values CHECK (RoomCount >= 0 AND RoomRevenue >= 0 AND (RoomsAvailable IS NULL OR RoomsAvailable >= RoomCount))
);
CREATE INDEX IX_BookingPositionSnapshot_Capture ON juyo.BookingPositionSnapshot(CapturedAsOf, HotelId, StayDate);
GO

CREATE TABLE juyo.EventVenue (
    VenueId varchar(64) NOT NULL,
    CityId varchar(64) NOT NULL,
    Name nvarchar(200) NOT NULL,
    Latitude decimal(9,6) NOT NULL,
    Longitude decimal(9,6) NOT NULL,
    CONSTRAINT PK_EventVenue PRIMARY KEY CLUSTERED (VenueId),
    CONSTRAINT FK_EventVenue_City FOREIGN KEY (CityId) REFERENCES juyo.City(CityId),
    CONSTRAINT UQ_EventVenue_CityName UNIQUE (CityId, Name),
    CONSTRAINT CK_EventVenue_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0),
    CONSTRAINT CK_EventVenue_Coordinates CHECK (Latitude BETWEEN -90 AND 90 AND Longitude BETWEEN -180 AND 180)
);
GO

CREATE TABLE juyo.HotelEvent (
    EventId varchar(64) NOT NULL,
    VenueId varchar(64) NOT NULL,
    Name nvarchar(200) NOT NULL,
    CategoryCode varchar(32) NOT NULL,
    StartDate date NOT NULL,
    EndDate date NOT NULL,
    ExpectedAttendance int NOT NULL,
    CONSTRAINT PK_HotelEvent PRIMARY KEY CLUSTERED (EventId),
    CONSTRAINT FK_HotelEvent_Venue FOREIGN KEY (VenueId) REFERENCES juyo.EventVenue(VenueId),
    CONSTRAINT FK_HotelEvent_Category FOREIGN KEY (CategoryCode) REFERENCES juyo.EventCategory(Code),
    CONSTRAINT CK_HotelEvent_Name CHECK (LEN(LTRIM(RTRIM(Name))) > 0),
    CONSTRAINT CK_HotelEvent_Dates CHECK (StartDate <= EndDate),
    CONSTRAINT CK_HotelEvent_Attendance CHECK (ExpectedAttendance >= 0)
);
CREATE INDEX IX_HotelEvent_Dates ON juyo.HotelEvent(StartDate, EndDate);
CREATE INDEX IX_HotelEvent_Venue ON juyo.HotelEvent(VenueId);
GO

CREATE TABLE juyo.EventHotelAssessment (
    EventId varchar(64) NOT NULL,
    HotelId varchar(64) NOT NULL,
    ImportanceCode varchar(32) NOT NULL,
    Reason nvarchar(2000) NOT NULL,
    DistanceKm decimal(10,2) NOT NULL,
    SourceCode varchar(32) NOT NULL,
    AssessedOn date NOT NULL,
    CONSTRAINT PK_EventHotelAssessment PRIMARY KEY CLUSTERED (EventId, HotelId),
    CONSTRAINT FK_EventHotelAssessment_Event FOREIGN KEY (EventId) REFERENCES juyo.HotelEvent(EventId),
    CONSTRAINT FK_EventHotelAssessment_Hotel FOREIGN KEY (HotelId) REFERENCES juyo.Hotel(HotelId),
    CONSTRAINT FK_EventHotelAssessment_Importance FOREIGN KEY (ImportanceCode) REFERENCES juyo.EventImportance(Code),
    CONSTRAINT FK_EventHotelAssessment_Source FOREIGN KEY (SourceCode) REFERENCES juyo.AssessmentSource(Code),
    CONSTRAINT CK_EventHotelAssessment_Distance CHECK (DistanceKm >= 0),
    CONSTRAINT CK_EventHotelAssessment_Reason CHECK (LEN(LTRIM(RTRIM(Reason))) > 0)
);
CREATE INDEX IX_EventHotelAssessment_Hotel ON juyo.EventHotelAssessment(HotelId, EventId);
GO

-- Enforce hotel-scoped room numbers without copying HotelId into Room.
CREATE VIEW juyo.RoomNumberScope
WITH SCHEMABINDING
AS
SELECT t.HotelId, r.[Number], r.RoomId
FROM juyo.Room AS r
INNER JOIN juyo.RoomType AS t ON t.RoomTypeId = r.RoomTypeId;
GO

CREATE UNIQUE CLUSTERED INDEX UX_RoomNumberScope_HotelNumber ON juyo.RoomNumberScope(HotelId, [Number]);
GO

-- The unique allocation index prevents two accepted reservations from selling one room/date.
CREATE VIEW juyo.RoomNightAllocation
WITH SCHEMABINDING
AS
SELECT a.RoomId, n.StayDate, n.ReservationId
FROM juyo.ReservationNight AS n
INNER JOIN juyo.ReservationRoomAssignment AS a ON a.ReservationId = n.ReservationId;
GO

CREATE UNIQUE CLUSTERED INDEX UX_RoomNightAllocation_RoomDate ON juyo.RoomNightAllocation(RoomId, StayDate);
GO

-- Cross-table business rules use set-based triggers. HOLDLOCK serializes the
-- relevant parent facts with concurrent updates; indexed views enforce uniqueness.
CREATE TRIGGER juyo.TR_Reservation_Validate
ON juyo.Reservation
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        INNER JOIN juyo.RoomType AS t WITH (UPDLOCK, HOLDLOCK) ON t.RoomTypeId = i.RoomTypeId
        WHERE i.Adults > t.MaxAdults OR i.Children > t.MaxChildren
    )
        THROW 51001, 'Reservation party exceeds the requested room type capacity.', 1;

    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        INNER JOIN juyo.ReservationRoomAssignment AS a WITH (UPDLOCK, HOLDLOCK) ON a.ReservationId = i.ReservationId
        INNER JOIN juyo.Room AS r WITH (UPDLOCK, HOLDLOCK) ON r.RoomId = a.RoomId
        WHERE r.RoomTypeId <> i.RoomTypeId
    )
        THROW 51002, 'Assigned room must belong to the reservation room type.', 1;

    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        INNER JOIN juyo.ReservationNight AS n WITH (UPDLOCK, HOLDLOCK) ON n.ReservationId = i.ReservationId
        WHERE i.StatusCode NOT IN ('confirmed', 'checked_in', 'checked_out')
            OR n.StayDate < i.ArrivalDate OR n.StayDate >= i.DepartureDate
    )
        THROW 51003, 'Accepted nights require an accepted reservation and dates inside its stay.', 1;
END;
GO

CREATE TRIGGER juyo.TR_ReservationRoomAssignment_Validate
ON juyo.ReservationRoomAssignment
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        INNER JOIN juyo.Reservation AS r WITH (UPDLOCK, HOLDLOCK) ON r.ReservationId = i.ReservationId
        INNER JOIN juyo.Room AS m WITH (UPDLOCK, HOLDLOCK) ON m.RoomId = i.RoomId
        WHERE r.RoomTypeId <> m.RoomTypeId
    )
        THROW 51004, 'Assigned room must belong to the reservation room type.', 1;

    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        INNER JOIN juyo.ReservationNight AS n WITH (UPDLOCK, HOLDLOCK) ON n.ReservationId = i.ReservationId
        LEFT JOIN juyo.RoomDailyState AS s WITH (UPDLOCK, HOLDLOCK)
            ON s.RoomId = i.RoomId AND s.StayDate = n.StayDate
        WHERE s.RoomId IS NULL OR s.IsOutOfService = 1
    )
        THROW 51005, 'Accepted nights require dated in-service room inventory.', 1;
END;
GO

CREATE TRIGGER juyo.TR_Room_ValidateAssignments
ON juyo.Room
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        INNER JOIN juyo.ReservationRoomAssignment AS a WITH (UPDLOCK, HOLDLOCK) ON a.RoomId = i.RoomId
        INNER JOIN juyo.Reservation AS r WITH (UPDLOCK, HOLDLOCK) ON r.ReservationId = a.ReservationId
        WHERE r.RoomTypeId <> i.RoomTypeId
    )
        THROW 51006, 'A room type change cannot invalidate existing reservation assignments.', 1;
END;
GO

CREATE TRIGGER juyo.TR_RoomType_ValidateCapacity
ON juyo.RoomType
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        INNER JOIN juyo.Reservation AS r WITH (UPDLOCK, HOLDLOCK) ON r.RoomTypeId = i.RoomTypeId
        WHERE r.Adults > i.MaxAdults OR r.Children > i.MaxChildren
    )
        THROW 51007, 'A room type capacity change cannot invalidate existing reservations.', 1;
END;
GO

CREATE TRIGGER juyo.TR_ReservationNight_Validate
ON juyo.ReservationNight
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        INNER JOIN juyo.Reservation AS r WITH (UPDLOCK, HOLDLOCK) ON r.ReservationId = i.ReservationId
        WHERE r.StatusCode NOT IN ('confirmed', 'checked_in', 'checked_out')
            OR i.StayDate < r.ArrivalDate OR i.StayDate >= r.DepartureDate
    )
        THROW 51008, 'Accepted nights require an accepted reservation and dates inside its stay.', 1;

    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        INNER JOIN juyo.ReservationRoomAssignment AS a WITH (UPDLOCK, HOLDLOCK) ON a.ReservationId = i.ReservationId
        LEFT JOIN juyo.RoomDailyState AS s WITH (UPDLOCK, HOLDLOCK)
            ON s.RoomId = a.RoomId AND s.StayDate = i.StayDate
        WHERE s.RoomId IS NULL OR s.IsOutOfService = 1
    )
        THROW 51009, 'Accepted nights require dated in-service room inventory.', 1;
END;
GO

CREATE TRIGGER juyo.TR_RoomDailyState_ValidateAcceptedNights
ON juyo.RoomDailyState
AFTER INSERT, UPDATE, DELETE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1
        FROM (
            SELECT RoomId, StayDate FROM inserted
            UNION
            SELECT RoomId, StayDate FROM deleted
        ) AS changed
        INNER JOIN juyo.RoomNightAllocation AS n WITH (UPDLOCK, HOLDLOCK)
            ON n.RoomId = changed.RoomId AND n.StayDate = changed.StayDate
        LEFT JOIN juyo.RoomDailyState AS s
            ON s.RoomId = changed.RoomId AND s.StayDate = changed.StayDate
        WHERE s.RoomId IS NULL OR s.IsOutOfService = 1
    )
        THROW 51010, 'Room-state changes cannot invalidate accepted room nights.', 1;
END;
GO

CREATE TRIGGER juyo.TR_Restaurant_ValidateFacility
ON juyo.Restaurant
AFTER INSERT, UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        INNER JOIN juyo.Facility AS f WITH (UPDLOCK, HOLDLOCK) ON f.FacilityId = i.FacilityId
        WHERE f.KindCode <> 'restaurant'
    )
        THROW 51011, 'Restaurant details require a restaurant facility.', 1;
END;
GO

CREATE TRIGGER juyo.TR_Facility_ValidateRestaurant
ON juyo.Facility
AFTER UPDATE
AS
BEGIN
    SET NOCOUNT ON;
    IF EXISTS (
        SELECT 1
        FROM inserted AS i
        INNER JOIN juyo.Restaurant AS r WITH (UPDLOCK, HOLDLOCK) ON r.FacilityId = i.FacilityId
        WHERE i.KindCode <> 'restaurant'
    )
        THROW 51012, 'A restaurant facility cannot change kind while restaurant details exist.', 1;
END;
GO
