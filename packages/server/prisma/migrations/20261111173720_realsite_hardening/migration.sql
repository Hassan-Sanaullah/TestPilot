-- AlterTable
ALTER TABLE "Step" ADD COLUMN "observation" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Project" ("baseUrl", "createdAt", "description", "id", "llmCallBudget", "name", "resetUrl", "retryOnFail", "testPassword", "testUser") SELECT "baseUrl", "createdAt", "description", "id", "llmCallBudget", "name", "resetUrl", "retryOnFail", "testPassword", "testUser" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
