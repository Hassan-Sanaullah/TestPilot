-- AlterTable
ALTER TABLE "Requirement" ADD COLUMN "pageUrl" TEXT;
ALTER TABLE "Requirement" ADD COLUMN "ruleText" TEXT;

-- AlterTable
ALTER TABLE "Step" ADD COLUMN "changes" TEXT;

-- CreateTable
CREATE TABLE "TestRequirement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "testCaseId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'generated',
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TestRequirement_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TestRequirement_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SuiteRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "total" INTEGER NOT NULL DEFAULT 0,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "errored" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "SuiteRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AppPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'other',
    "forms" TEXT NOT NULL DEFAULT '[]',
    "actions" TEXT NOT NULL DEFAULT '[]',
    "rules" TEXT NOT NULL DEFAULT '[]',
    "headings" TEXT NOT NULL DEFAULT '[]',
    "samples" TEXT NOT NULL DEFAULT '[]',
    "reachedVia" TEXT NOT NULL DEFAULT '',
    "requiresAuth" BOOLEAN NOT NULL DEFAULT false,
    "discoveredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppPage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AppPage" ("actions", "discoveredAt", "forms", "headings", "id", "kind", "projectId", "reachedVia", "requiresAuth", "rules", "title", "url") SELECT "actions", "discoveredAt", "forms", "headings", "id", "kind", "projectId", "reachedVia", "requiresAuth", "rules", "title", "url" FROM "AppPage";
DROP TABLE "AppPage";
ALTER TABLE "new_AppPage" RENAME TO "AppPage";
CREATE UNIQUE INDEX "AppPage_projectId_url_key" ON "AppPage"("projectId", "url");
CREATE TABLE "new_BugReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testCaseId" TEXT,
    "fingerprint" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRunId" TEXT,
    "passingSince" DATETIME,
    "oracle" TEXT,
    "oracleText" TEXT,
    "title" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "stepsToReproduce" TEXT NOT NULL,
    "expected" TEXT NOT NULL,
    "actual" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "screenshotPath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BugReport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BugReport_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BugReport_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BugReport" ("actual", "createdAt", "expected", "id", "notes", "projectId", "runId", "screenshotPath", "severity", "status", "stepsToReproduce", "title") SELECT "actual", "createdAt", "expected", "id", "notes", "projectId", "runId", "screenshotPath", "severity", "status", "stepsToReproduce", "title" FROM "BugReport";
DROP TABLE "BugReport";
ALTER TABLE "new_BugReport" RENAME TO "BugReport";
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "resetUrl" TEXT,
    "testUser" TEXT,
    "testPassword" TEXT,
    "llmCallBudget" INTEGER NOT NULL DEFAULT 40,
    "retryOnFail" BOOLEAN NOT NULL DEFAULT true,
    "allowedDomains" TEXT NOT NULL DEFAULT '[]',
    "viewportWidth" INTEGER NOT NULL DEFAULT 1280,
    "viewportHeight" INTEGER NOT NULL DEFAULT 900,
    "maxSteps" INTEGER NOT NULL DEFAULT 30,
    "storageState" TEXT,
    "dialogAction" TEXT NOT NULL DEFAULT 'accept',
    "parallel" BOOLEAN NOT NULL DEFAULT true,
    "lastExploredAt" DATETIME,
    "testData" TEXT NOT NULL DEFAULT '{}',
    "autoSession" TEXT,
    "autoSessionAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Project" ("allowedDomains", "baseUrl", "createdAt", "description", "dialogAction", "id", "lastExploredAt", "llmCallBudget", "maxSteps", "name", "parallel", "resetUrl", "retryOnFail", "storageState", "testPassword", "testUser", "viewportHeight", "viewportWidth") SELECT "allowedDomains", "baseUrl", "createdAt", "description", "dialogAction", "id", "lastExploredAt", "llmCallBudget", "maxSteps", "name", "parallel", "resetUrl", "retryOnFail", "storageState", "testPassword", "testUser", "viewportHeight", "viewportWidth" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE TABLE "new_Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "testCaseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "retryOfId" TEXT,
    "flaky" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'ai',
    "healedSteps" INTEGER NOT NULL DEFAULT 0,
    "failureKind" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "verdict" TEXT,
    "reason" TEXT,
    "llmCalls" INTEGER NOT NULL DEFAULT 0,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "tracePath" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'normal',
    "flakyCause" TEXT,
    "anomalies" TEXT NOT NULL DEFAULT '[]',
    "oracle" TEXT,
    "model" TEXT,
    "suiteRunId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Run_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Run_suiteRunId_fkey" FOREIGN KEY ("suiteRunId") REFERENCES "SuiteRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Run" ("attempt", "completionTokens", "createdAt", "failureKind", "finishedAt", "flaky", "healedSteps", "id", "llmCalls", "mode", "promptTokens", "reason", "retryOfId", "startedAt", "status", "testCaseId", "tracePath", "verdict") SELECT "attempt", "completionTokens", "createdAt", "failureKind", "finishedAt", "flaky", "healedSteps", "id", "llmCalls", "mode", "promptTokens", "reason", "retryOfId", "startedAt", "status", "testCaseId", "tracePath", "verdict" FROM "Run";
DROP TABLE "Run";
ALTER TABLE "new_Run" RENAME TO "Run";
CREATE TABLE "new_TestCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'user',
    "gapScenarioId" TEXT,
    "script" TEXT,
    "scriptUpdatedAt" DATETIME,
    "scriptFromRunId" TEXT,
    "scriptVerifiedAt" DATETIME,
    "kind" TEXT NOT NULL DEFAULT 'happy-path',
    "technique" TEXT,
    "area" TEXT,
    "targetUrl" TEXT,
    "targetForm" TEXT,
    "targetField" TEXT,
    "designKey" TEXT,
    "oracle" TEXT,
    "oracleText" TEXT,
    "auth" TEXT NOT NULL DEFAULT 'auto',
    "priority" INTEGER NOT NULL DEFAULT 2,
    "expectation" TEXT NOT NULL DEFAULT 'pass',
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TestCase_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TestCase" ("createdAt", "gapScenarioId", "id", "instruction", "origin", "projectId", "script", "scriptFromRunId", "scriptUpdatedAt", "title") SELECT "createdAt", "gapScenarioId", "id", "instruction", "origin", "projectId", "script", "scriptFromRunId", "scriptUpdatedAt", "title" FROM "TestCase";
DROP TABLE "TestCase";
ALTER TABLE "new_TestCase" RENAME TO "TestCase";
CREATE UNIQUE INDEX "TestCase_projectId_designKey_key" ON "TestCase"("projectId", "designKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "TestRequirement_testCaseId_requirementId_key" ON "TestRequirement"("testCaseId", "requirementId");
