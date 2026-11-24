-- AlterTable
ALTER TABLE "Project" ADD COLUMN "lastExploredAt" DATETIME;

-- CreateTable
CREATE TABLE "AppPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'other',
    "forms" TEXT NOT NULL DEFAULT '[]',
    "actions" TEXT NOT NULL DEFAULT '[]',
    "rules" TEXT NOT NULL DEFAULT '[]',
    "headings" TEXT NOT NULL DEFAULT '[]',
    "reachedVia" TEXT NOT NULL DEFAULT '',
    "requiresAuth" BOOLEAN NOT NULL DEFAULT false,
    "discoveredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppPage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AppPage_projectId_url_key" ON "AppPage"("projectId", "url");
