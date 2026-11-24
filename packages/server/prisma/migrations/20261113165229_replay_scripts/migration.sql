-- AlterTable
ALTER TABLE "Step" ADD COLUMN "locator" TEXT;

-- AlterTable
ALTER TABLE "TestCase" ADD COLUMN "script" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "scriptFromRunId" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "scriptUpdatedAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "testCaseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "retryOfId" TEXT,
    "flaky" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'ai',
    "healedSteps" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "verdict" TEXT,
    "reason" TEXT,
    "llmCalls" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "tracePath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Run_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Run" ("attempt", "completionTokens", "createdAt", "finishedAt", "flaky", "id", "llmCalls", "promptTokens", "reason", "retryOfId", "startedAt", "status", "testCaseId", "tracePath", "verdict") SELECT "attempt", "completionTokens", "createdAt", "finishedAt", "flaky", "id", "llmCalls", "promptTokens", "reason", "retryOfId", "startedAt", "status", "testCaseId", "tracePath", "verdict" FROM "Run";
DROP TABLE "Run";
ALTER TABLE "new_Run" RENAME TO "Run";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
