-- Optional one-to-one hotel postal address. City/country and coordinates remain
-- owned by Hotel and its geography references; no location facts are duplicated.
-- The caller owns the transaction and immutable migration fingerprint.
CREATE TABLE juyo.HotelAddress (
    HotelId varchar(64) NOT NULL,
    Line1 nvarchar(200) NOT NULL,
    Line2 nvarchar(200) NULL,
    PostalCode nvarchar(20) NOT NULL,
    CONSTRAINT PK_HotelAddress PRIMARY KEY CLUSTERED (HotelId),
    CONSTRAINT FK_HotelAddress_Hotel FOREIGN KEY (HotelId) REFERENCES juyo.Hotel(HotelId),
    CONSTRAINT CK_HotelAddress_Line1 CHECK (LEN(LTRIM(RTRIM(Line1))) > 0),
    CONSTRAINT CK_HotelAddress_Line2 CHECK (Line2 IS NULL OR LEN(LTRIM(RTRIM(Line2))) > 0),
    CONSTRAINT CK_HotelAddress_PostalCode CHECK (LEN(LTRIM(RTRIM(PostalCode))) > 0)
);
GO
