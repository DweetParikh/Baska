-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Fund" (
    "id" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shareMint" TEXT NOT NULL,
    "mgmtFeeBps" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundComponent" (
    "id" SERIAL NOT NULL,
    "fundId" INTEGER NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "weightBps" INTEGER NOT NULL,

    CONSTRAINT "FundComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NavSnapshot" (
    "id" SERIAL NOT NULL,
    "fundId" INTEGER NOT NULL,
    "navPerShare" DECIMAL(24,6) NOT NULL,
    "tvlUsd" DECIMAL(24,6) NOT NULL,
    "totalShares" DECIMAL(24,6) NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NavSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" SERIAL NOT NULL,
    "wallet" TEXT NOT NULL,
    "fundId" INTEGER NOT NULL,
    "shares" DECIMAL(24,6) NOT NULL,
    "costBasis" DECIMAL(24,6) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tx" (
    "id" TEXT NOT NULL,
    "sig" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "fundId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "usdc" DECIMAL(24,6) NOT NULL,
    "shares" DECIMAL(24,6) NOT NULL,
    "slot" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexerState" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Fund_address_key" ON "Fund"("address");

-- CreateIndex
CREATE UNIQUE INDEX "FundComponent_fundId_mint_key" ON "FundComponent"("fundId", "mint");

-- CreateIndex
CREATE INDEX "NavSnapshot_fundId_ts_idx" ON "NavSnapshot"("fundId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "Position_wallet_fundId_key" ON "Position"("wallet", "fundId");

-- CreateIndex
CREATE INDEX "Tx_wallet_ts_idx" ON "Tx"("wallet", "ts");

-- CreateIndex
CREATE INDEX "Tx_sig_idx" ON "Tx"("sig");

-- AddForeignKey
ALTER TABLE "FundComponent" ADD CONSTRAINT "FundComponent_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NavSnapshot" ADD CONSTRAINT "NavSnapshot_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tx" ADD CONSTRAINT "Tx_fundId_fkey" FOREIGN KEY ("fundId") REFERENCES "Fund"("id") ON DELETE CASCADE ON UPDATE CASCADE;

