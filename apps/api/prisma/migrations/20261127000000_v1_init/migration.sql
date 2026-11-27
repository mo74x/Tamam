-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('STARTER', 'GROWTH', 'PRO');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'MODERATOR');

-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('WHATSAPP_COEXISTENCE', 'WHATSAPP_DEDICATED', 'WHATSAPP_FORWARD');

-- CreateEnum
CREATE TYPE "ProofStatus" AS ENUM ('PROCESSING', 'WAITING', 'CONFIRMED', 'SUSPICIOUS', 'UNMATCHED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "EvidenceSource" AS ENUM ('ANDROID_NOTIF', 'SMS_FORWARD', 'MANUAL_PASTE', 'EMAIL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('INSTAPAY', 'VODAFONE_CASH', 'ETISALAT_CASH', 'ORANGE_CASH', 'WE_PAY', 'BANK_TRANSFER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DecisionActor" AS ENUM ('SYSTEM', 'OWNER', 'MODERATOR');

-- CreateTable
CREATE TABLE "Seller" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "ownerPhone" TEXT NOT NULL,
    "plan" "PlanTier" NOT NULL DEFAULT 'STARTER',
    "evidenceSecretHash" TEXT NOT NULL,
    "matchWindowBeforeMs" INTEGER NOT NULL DEFAULT 900000,
    "matchWindowAfterMs" INTEGER NOT NULL DEFAULT 1800000,
    "waitingDebounceMs" INTEGER NOT NULL DEFAULT 20000,
    "retentionDays" INTEGER NOT NULL DEFAULT 14,
    "replyTemplates" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Seller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MODERATOR',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "type" "ChannelType" NOT NULL,
    "phoneNumberId" TEXT,
    "wabaId" TEXT,
    "encryptedToken" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "deviceLabel" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "tokenHash" TEXT,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "offlineAlerted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "displayName" TEXT,
    "trustScore" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proof" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "customerId" TEXT,
    "channelId" TEXT,
    "channelMessageId" TEXT NOT NULL,
    "imageKey" TEXT,
    "imageSha256" TEXT NOT NULL,
    "imagePhash" BIGINT,
    "isForwarded" BOOLEAN NOT NULL DEFAULT false,
    "replyToPhone" TEXT,
    "visionCostMicroUsd" INTEGER,
    "extractedAmountPiasters" BIGINT,
    "extractedRef" TEXT,
    "extractedTime" TIMESTAMP(3),
    "extractedSender" TEXT,
    "extractedMethod" "PaymentMethod" NOT NULL DEFAULT 'UNKNOWN',
    "extractionConfidence" DOUBLE PRECISION,
    "extractionRaw" JSONB,
    "status" "ProofStatus" NOT NULL DEFAULT 'PROCESSING',
    "statusReason" TEXT,
    "waitingReplySent" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "source" "EvidenceSource" NOT NULL,
    "senderApp" TEXT,
    "dedupeHash" TEXT NOT NULL,
    "semanticKey" TEXT,
    "rawText" TEXT,
    "parsedAmountPiasters" BIGINT,
    "parsedRef" TEXT,
    "parsedTime" TIMESTAMP(3),
    "parsedSender" TEXT,
    "parserName" TEXT NOT NULL,
    "parseConfidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "claimedByProofId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "monthKey" TEXT NOT NULL,
    "proofCount" INTEGER NOT NULL DEFAULT 0,
    "visionCalls" INTEGER NOT NULL DEFAULT 0,
    "llmFallbackCalls" INTEGER NOT NULL DEFAULT 0,
    "visionCostMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "templateAlertsSent" INTEGER NOT NULL DEFAULT 0,
    "quotaWarningSent" BOOLEAN NOT NULL DEFAULT false,
    "quotaAlertSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "decidedBy" "DecisionActor" NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Seller_ownerPhone_key" ON "Seller"("ownerPhone");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_sellerId_phone_key" ON "TeamMember"("sellerId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "Channel_phoneNumberId_key" ON "Channel"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- CreateIndex
CREATE INDEX "Device_sellerId_lastHeartbeatAt_idx" ON "Device"("sellerId", "lastHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "Device_sellerId_deviceLabel_key" ON "Device"("sellerId", "deviceLabel");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_sellerId_phone_key" ON "Customer"("sellerId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "Proof_channelMessageId_key" ON "Proof"("channelMessageId");

-- CreateIndex
CREATE INDEX "Proof_sellerId_status_createdAt_idx" ON "Proof"("sellerId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Proof_sellerId_extractedRef_idx" ON "Proof"("sellerId", "extractedRef");

-- CreateIndex
CREATE INDEX "Proof_sellerId_imageSha256_idx" ON "Proof"("sellerId", "imageSha256");

-- CreateIndex
CREATE INDEX "Proof_sellerId_createdAt_idx" ON "Proof"("sellerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_dedupeHash_key" ON "Evidence"("dedupeHash");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_semanticKey_key" ON "Evidence"("semanticKey");

-- CreateIndex
CREATE UNIQUE INDEX "Evidence_claimedByProofId_key" ON "Evidence"("claimedByProofId");

-- CreateIndex
CREATE INDEX "Evidence_sellerId_parsedAmountPiasters_receivedAt_idx" ON "Evidence"("sellerId", "parsedAmountPiasters", "receivedAt");

-- CreateIndex
CREATE INDEX "Evidence_sellerId_parsedRef_idx" ON "Evidence"("sellerId", "parsedRef");

-- CreateIndex
CREATE UNIQUE INDEX "UsageRecord_sellerId_monthKey_key" ON "UsageRecord"("sellerId", "monthKey");

-- CreateIndex
CREATE UNIQUE INDEX "Match_proofId_key" ON "Match"("proofId");

-- CreateIndex
CREATE UNIQUE INDEX "Match_evidenceId_key" ON "Match"("evidenceId");

-- CreateIndex
CREATE INDEX "AuditLog_sellerId_entityType_entityId_idx" ON "AuditLog"("sellerId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_sellerId_createdAt_idx" ON "AuditLog"("sellerId", "createdAt");

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proof" ADD CONSTRAINT "Proof_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proof" ADD CONSTRAINT "Proof_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proof" ADD CONSTRAINT "Proof_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_claimedByProofId_fkey" FOREIGN KEY ("claimedByProofId") REFERENCES "Proof"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "Proof"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only AuditLog protection
REVOKE UPDATE, DELETE ON "AuditLog" FROM PUBLIC;
