
'use server';

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { Database as JsonDatabase, BrandingSettings, CleanupSettings, FileStatus, MonitoredPaths, ProcessingSettings, SmtpSettings, User, MaintenanceSettings, LogEntry } from '../types';

const dataDir = path.resolve(process.cwd(), 'data');
const defaultDbPath = path.resolve(dataDir, 'database.sqlite');
const dbPath = process.env.DATABASE_PATH || defaultDbPath;
const jsonDbPath = path.resolve(process.cwd(), 'src/lib/database.json');
const jsonDbMigratedPath = path.resolve(process.cwd(), 'src/lib/database.json.migrated');

// Establish a singleton database connection
let dbInstance: Database.Database | null = null;

function migrateDataFromJson(db: Database.Database) {
    console.log('[DB] Checking if data migration is needed...');
    if (!fs.existsSync(jsonDbPath)) {
        console.log('[DB] JSON database not found, skipping migration.');
        return;
    }
     if (fs.existsSync(jsonDbMigratedPath)) {
        // Migration has already happened
        return;
    }

    console.log('[DB] Found database.json, starting one-time migration to SQLite...');
    
    try {
        const jsonString = fs.readFileSync(jsonDbPath, 'utf-8');
        const jsonData: JsonDatabase = JSON.parse(jsonString);

        db.transaction(() => {
            // Clean tables before migrating
            db.exec('DELETE FROM users');
            db.exec('DELETE FROM file_statuses');
            db.exec('DELETE FROM settings');
            db.exec('DELETE FROM logs');

            // Users
            const insertUser = db.prepare('INSERT OR REPLACE INTO users (id, username, name, email, role, password, avatar, twoFactorRequired, twoFactorSecret, lastLogin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            jsonData.users.forEach(user => {
                insertUser.run(
                    user.id,
                    user.username,
                    user.name,
                    user.email || null,
                    user.role,
                    user.password || null,
                    user.avatar || null,
                    user.twoFactorRequired ? 1 : 0,
                    user.twoFactorSecret || null,
                    user.lastLogin || null
                );
            });
            console.log(`[DB] Migrated ${jsonData.users.length} users.`);

            // Settings (key-value store)
            const insertSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
            insertSetting.run('branding', JSON.stringify(jsonData.branding));
            insertSetting.run('monitoredPaths', JSON.stringify(jsonData.monitoredPaths));
            insertSetting.run('monitoredExtensions', JSON.stringify(jsonData.monitoredExtensions));
            insertSetting.run('cleanupSettings', JSON.stringify(jsonData.cleanupSettings));
            insertSetting.run('processingSettings', JSON.stringify(jsonData.processingSettings));
            insertSetting.run('failureRemark', JSON.stringify(jsonData.failureRemark));
            insertSetting.run('smtpSettings', JSON.stringify(jsonData.smtpSettings));
            insertSetting.run('maintenanceSettings', JSON.stringify(jsonData.maintenanceSettings));
            console.log('[DB] Migrated application settings.');

            // File Statuses
            const insertStatus = db.prepare('INSERT OR REPLACE INTO file_statuses (id, name, status, source, lastUpdated, remarks) VALUES (?, ?, ?, ?, ?, ?)');
            jsonData.fileStatuses.forEach(status => {
                insertStatus.run(
                    status.id,
                    status.name,
                    status.status,
                    status.source,
                    status.lastUpdated,
                    status.remarks || null
                );
            });
            console.log(`[DB] Migrated ${jsonData.fileStatuses.length} file statuses.`);

            // Logs (might not exist in old JSON)
            if (jsonData.logs) {
                const insertLog = db.prepare('INSERT OR REPLACE INTO logs (id, timestamp, level, actor, action, details) VALUES (?, ?, ?, ?, ?, ?)');
                jsonData.logs.forEach(log => {
                    insertLog.run(log.id, log.timestamp, log.level, log.actor, log.action, log.details);
                });
                console.log(`[DB] Migrated ${jsonData.logs.length} logs.`);
            }


        })();

        // Rename the old JSON file to prevent re-migration
        fs.renameSync(jsonDbPath, jsonDbMigratedPath);
        console.log('[DB] Migration successful. Renamed database.json to database.json.migrated.');

    } catch (error) {
        console.error('[DB] CRITICAL: Failed to migrate data from database.json to SQLite.', error);
        // If migration fails, we stop the process to avoid data inconsistency.
        throw new Error('Database migration failed.');
    }
}

const getDb = (): Database.Database => {
    if (!dbInstance) {
        console.log(`[DB] Initializing new SQLite singleton connection to: ${dbPath}`);
        
        // Ensure the data directory exists before connecting
        if (!fs.existsSync(dataDir)) {
            console.log(`[DB] Data directory not found. Creating: ${dataDir}`);
            try {
                fs.mkdirSync(dataDir, { recursive: true });
            } catch (e: any) {
                console.error(`[DB] CRITICAL: Could not create data directory at ${dataDir}. Please create it manually and grant write permissions.`, e);
                throw e;
            }
        }
        
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');

        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                email TEXT UNIQUE,
                role TEXT NOT NULL,
                password TEXT,
                avatar TEXT,
                twoFactorRequired INTEGER DEFAULT 0,
                twoFactorSecret TEXT,
                lastLogin TEXT
            );

            CREATE TABLE IF NOT EXISTS file_statuses (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL,
                source TEXT NOT NULL,
                lastUpdated TEXT NOT NULL,
                remarks TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_file_statuses_name ON file_statuses(name);
            CREATE INDEX IF NOT EXISTS idx_file_statuses_status ON file_statuses(status);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            
            CREATE TABLE IF NOT EXISTS logs (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                level TEXT NOT NULL,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
            CREATE INDEX IF NOT EXISTS idx_logs_actor ON logs(actor);
            CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
        `);
        
        dbInstance = db;
        
        // Simple migration to add lastLogin column if it doesn't exist
        try {
            const tableInfo: any[] = dbInstance.prepare("PRAGMA table_info(users)").all();
            const hasLastLogin = tableInfo.some((col: any) => col.name === 'lastLogin');

            if (!hasLastLogin) {
                console.log('[DB] Migrating users table: adding lastLogin column...');
                dbInstance.exec('ALTER TABLE users ADD COLUMN lastLogin TEXT');
                console.log('[DB] Migration complete.');
            }
        } catch (e) {
            console.error('[DB] Error during users table migration check:', e);
        }

        migrateDataFromJson(dbInstance);
    }
    return dbInstance;
};


// --- Generic Setting Helpers ---
async function getSetting<T>(key: string, defaultValue: T): Promise<T> {
    const db = getDb();
    const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    const result = stmt.get(key) as { value: string } | undefined;
    return result ? JSON.parse(result.value) : defaultValue;
}

async function updateSetting<T>(key: string, value: T): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    stmt.run(key, JSON.stringify(value));
}

// --- USERS ---
export async function getUsers(): Promise<User[]> {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM users');
    const rows = stmt.all() as any[];
    return rows.map(row => ({ ...row, twoFactorRequired: !!row.twoFactorRequired })) as User[];
}

export async function getUserById(id: string): Promise<User | null> {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? { ...row, twoFactorRequired: !!row.twoFactorRequired } as User : null;
}

export async function getUserByUsername(username: string): Promise<User | null> {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
    const row = stmt.get(username) as any;
    return row ? { ...row, twoFactorRequired: !!row.twoFactorRequired } as User : null;
}

export async function addUser(user: User): Promise<{ success: boolean }> {
    const db = getDb();
    try {
        const stmt = db.prepare('INSERT INTO users (id, username, name, email, role, password, avatar, twoFactorRequired, twoFactorSecret) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        stmt.run(
            user.id, user.username, user.name, user.email || null, user.role, 
            user.password || null, user.avatar || null, 
            user.twoFactorRequired ? 1 : 0, user.twoFactorSecret || null
        );
        return { success: true };
    } catch (error: any) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return { success: false };
        }
        throw error;
    }
}

export async function updateUser(user: User): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('UPDATE users SET username = ?, name = ?, email = ?, role = ?, password = ?, avatar = ?, twoFactorRequired = ?, twoFactorSecret = ?, lastLogin = ? WHERE id = ?');
    stmt.run(
        user.username, user.name, user.email || null, user.role, 
        user.password, user.avatar || null, user.twoFactorRequired ? 1 : 0, 
        user.twoFactorSecret || null, user.lastLogin || null, user.id
    );
}

export async function bulkUpsertUsers(users: User[]): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('INSERT OR REPLACE INTO users (id, username, name, email, role, avatar, twoFactorRequired, twoFactorSecret, lastLogin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const transaction = db.transaction((usersToInsert: User[]) => {
        for (const user of usersToInsert) {
             stmt.run(
                user.id, user.username, user.name, user.email || null, user.role, 
                user.avatar || null, user.twoFactorRequired ? 1 : 0, user.twoFactorSecret || null, user.lastLogin || null
            );
        }
    });
    transaction(users);
}

export async function bulkUpsertUsersWithPasswords(users: User[]): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('INSERT OR REPLACE INTO users (id, username, name, email, role, password, avatar, twoFactorRequired, twoFactorSecret, lastLogin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const transaction = db.transaction((usersToInsert: User[]) => {
        for (const user of usersToInsert) {
             stmt.run(
                user.id, user.username, user.name, user.email || null, user.role, 
                user.password, user.avatar || null, user.twoFactorRequired ? 1 : 0, 
                user.twoFactorSecret || null, user.lastLogin || null
            );
        }
    });
    transaction(users);
}

export async function updateUserPassword(userId: string, newPassword: string): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('UPDATE users SET password = ? WHERE id = ?');
    stmt.run(newPassword, userId);
}

export async function updateUserLastLogin(userId: string): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('UPDATE users SET lastLogin = ? WHERE id = ?');
    stmt.run(new Date().toISOString(), userId);
}


export async function removeUser(userId: string): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM users WHERE id = ?');
    stmt.run(userId);
}


// --- FILE STATUSES ---
export async function getFileStatuses(): Promise<FileStatus[]> {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM file_statuses ORDER BY lastUpdated DESC');
    return stmt.all() as FileStatus[];
}

export async function getFileStatusByName(name: string): Promise<FileStatus | null> {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM file_statuses WHERE name = ?');
    return stmt.get(name) as FileStatus || null;
}

export async function upsertFileStatus(file: FileStatus): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('INSERT OR REPLACE INTO file_statuses (id, name, status, source, lastUpdated, remarks) VALUES (?, ?, ?, ?, ?, ?)');
    stmt.run(file.id, file.name, file.status, file.source, file.lastUpdated, file.remarks || null);
}

export async function bulkUpsertFileStatuses(files: FileStatus[]): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('INSERT OR REPLACE INTO file_statuses (id, name, status, source, lastUpdated, remarks) VALUES (?, ?, ?, ?, ?, ?)');
    const transaction = db.transaction((filesToInsert: FileStatus[]) => {
        for (const file of filesToInsert) {
            stmt.run(file.id, file.name, file.status, file.source, file.lastUpdated, file.remarks || null);
        }
    });
    transaction(files);
}

export async function deleteFileStatus(name: string): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM file_statuses WHERE name = ?');
    stmt.run(name);
}

export async function deleteAllFileStatuses(): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM file_statuses');
    stmt.run();
}


export async function deleteFileStatusesByAge(maxAgeMs: number): Promise<number> {
    const db = getDb();
    const cutoffDate = new Date(Date.now() - maxAgeMs).toISOString();
    const stmt = db.prepare('DELETE FROM file_statuses WHERE lastUpdated <= ?');
    const result = stmt.run(cutoffDate);
    return result.changes;
}

// --- LOGS ---
export async function getLogs(): Promise<LogEntry[]> {
    const db = getDb();
    const stmt = db.prepare('SELECT * FROM logs ORDER BY timestamp DESC');
    return stmt.all() as LogEntry[];
}

export async function addLog(log: LogEntry): Promise<void> {
    const db = getDb();
    const stmt = db.prepare('INSERT INTO logs (id, timestamp, level, actor, action, details) VALUES (?, ?, ?, ?, ?, ?)');
    stmt.run(log.id, log.timestamp, log.level, log.actor, log.action, log.details);
}

export async function deleteLogsByAge(maxAgeMs: number): Promise<number> {
    const db = getDb();
    const cutoffDate = new Date(Date.now() - maxAgeMs).toISOString();
    const stmt = db.prepare('DELETE FROM logs WHERE timestamp <= ?');
    const result = stmt.run(cutoffDate);
    return result.changes;
}


// --- SETTINGS ---
export async function getBranding(): Promise<BrandingSettings> {
    return getSetting<BrandingSettings>('branding', {
        brandName: 'Publish Lookout',
        logo: null,
        favicon: null,
        footerText: '© 2024 Publish Lookout'
    });
}
export async function updateBranding(settings: BrandingSettings): Promise<void> {
    return updateSetting('branding', settings);
}

export async function getMonitoredPaths(): Promise<MonitoredPaths> {
    return getSetting<MonitoredPaths>('monitoredPaths', {
        import: { id: 'import-path', name: 'Import', path: '' },
        failed: { id: 'failed-path', name: 'Failed', path: '' }
    });
}
export async function updateMonitoredPaths(settings: MonitoredPaths): Promise<void> {
    return updateSetting('monitoredPaths', settings);
}

export async function getMonitoredExtensions(): Promise<string[]> {
    return getSetting<string[]>('monitoredExtensions', []);
}
export async function updateMonitoredExtensions(extensions: string[]): Promise<void> {
    return updateSetting('monitoredExtensions', extensions);
}

export async function getCleanupSettings(): Promise<CleanupSettings> {
    return getSetting<CleanupSettings>('cleanupSettings', {
        status: { enabled: true, value: '7', unit: 'days' },
        files: { enabled: false, value: '30', 'unit': 'days' },
        timeout: { enabled: true, value: '24', unit: 'hours' }
    });
}
export async function updateCleanupSettings(settings: CleanupSettings): Promise<void> {
    return updateSetting('cleanupSettings', settings);
}

export async function getProcessingSettings(): Promise<ProcessingSettings> {
    return getSetting<ProcessingSettings>('processingSettings', {
        autoTrimInvalidChars: false,
        autoExpandPrefixes: false,
    });
}
export async function updateProcessingSettings(settings: ProcessingSettings): Promise<void> {
    return updateSetting('processingSettings', settings);
}

export async function getFailureRemark(): Promise<string> {
    return getSetting<string>('failureRemark', 'AUTOMATION ERROR: Contact Support');
}
export async function updateFailureRemark(remark: string): Promise<void> {
    return updateSetting('failureRemark', remark);
}

export async function getSmtpSettings(): Promise<SmtpSettings> {
    return getSetting<SmtpSettings>('smtpSettings', {
        host: '',
        port: 587,
        secure: false,
        auth: { user: '', pass: '' }
    });
}
export async function updateSmtpSettings(settings: SmtpSettings): Promise<void> {
    return updateSetting('smtpSettings', settings);
}

export async function getMaintenanceSettings(): Promise<MaintenanceSettings> {
    return getSetting<MaintenanceSettings>('maintenanceSettings', {
        enabled: false,
        message: "Maintenance in Progress\n\n{Brand Name} is currently down for maintenance. We’re performing necessary updates to improve performance and reliability. Please check back later."
    });
}
export async function updateMaintenanceSettings(settings: MaintenanceSettings): Promise<void> {
    return updateSetting('maintenanceSettings', settings);
}

// --- Compatibility layer for old readDb/writeDb calls ---
// This allows us to refactor actions.ts incrementally.
export async function readDb(): Promise<JsonDatabase> {
    const [
        users,
        branding,
        monitoredPaths,
        monitoredExtensions,
        fileStatuses,
        logs,
        cleanupSettings,
        processingSettings,
        failureRemark,
        smtpSettings,
        maintenanceSettings,
    ] = await Promise.all([
        getUsers(),
        getBranding(),
        getMonitoredPaths(),
        getMonitoredExtensions(),
        getFileStatuses(),
        getLogs(),
        getCleanupSettings(),
        getProcessingSettings(),
        getFailureRemark(),
        getSmtpSettings(),
        getMaintenanceSettings(),
    ]);
    return {
        users,
        branding,
        monitoredPaths,
        monitoredExtensions,
        fileStatuses,
        logs,
        cleanupSettings,
        processingSettings,
        failureRemark,
        smtpSettings,
        maintenanceSettings,
    };
}
