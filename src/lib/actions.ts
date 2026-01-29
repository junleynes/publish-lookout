
'use server';

import { revalidatePath } from 'next/cache';
import * as db from './db';
import type { BrandingSettings, CleanupSettings, MonitoredPaths, User, FileStatus, MonitoredPath, SmtpSettings, ProcessingSettings, ChartData, Database, MaintenanceSettings, LogEntry } from '../types';
import * as fs from 'fs/promises';
import * as path from 'path';
import { authenticator } from 'otplib';
import qrcode from 'qrcode';
import nodemailer from 'nodemailer';
import Papa from 'papaparse';
import { format, parseISO, startOfWeek, startOfMonth } from 'date-fns';
import { writeLog } from './logger';


export async function ensureAdminUserExists() {
  const adminUser = await db.getUserByUsername('admin');
  if (!adminUser) {
    console.log("Admin user not found, creating one.");
    await writeLog({ level: 'INFO', actor: 'system', action: 'CREATE_DEFAULT_ADMIN', details: 'Initial admin user created with default password.' });
    const newAdmin: User = {
      id: 'user-admin-initial',
      username: 'admin',
      name: 'Default Admin',
      email: 'admin@example.com',
      role: 'admin',
      password: 'P@ssw00rd',
    };
    await db.addUser(newAdmin);
    console.log("Default admin user created.");
  }
}

export async function validateUserCredentials(username: string, password: string):Promise<{ success: boolean; user?: User }> {
  const user = await db.getUserByUsername(username);
  if (user && user.password === password) {
    await writeLog({ level: 'AUDIT', actor: username, action: 'USER_LOGIN_SUCCESS', details: `User '${username}' logged in successfully.` });
    return { success: true, user: user };
  }
  await writeLog({ level: 'WARN', actor: 'system', action: 'USER_LOGIN_FAILED', details: `Failed login attempt for username: '${username}'.` });
  return { success: false };
}


export async function generateTwoFactorSecretForUser(userId: string, username: string, issuer: string) {
  let user = await db.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  // Only generate a new secret if one doesn't already exist.
  if (!user.twoFactorSecret) {
    const secret = authenticator.generateSecret();
    user.twoFactorSecret = secret;
    await db.updateUser(user);
    await writeLog({ level: 'AUDIT', actor: username, action: '2FA_SECRET_GENERATED', details: `Generated new 2FA secret for user '${username}'.` });
    revalidatePath('/users');
  }
  
  const otpauth = authenticator.keyuri(username, issuer, user.twoFactorSecret!);
  const qrCodeDataUrl = await qrcode.toDataURL(otpauth);

  return { qrCodeDataUrl };
}

export async function enableTwoFactor(userId: string) {
    let user = await db.getUserById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    user.twoFactorRequired = true;
    await db.updateUser(user);
    await writeLog({ level: 'AUDIT', actor: 'system', action: '2FA_ENABLED', details: `2FA requirement enabled for user '${user.username}'.` });
    revalidatePath('/users');
}

export async function disableTwoFactor(userId: string) {
    let user = await db.getUserById(userId);
    if (!user) {
        throw new Error('User not found');
    }

    user.twoFactorRequired = false;
    user.twoFactorSecret = null; // Clear the secret when disabling
    await db.updateUser(user);
    await writeLog({ level: 'AUDIT', actor: 'system', action: '2FA_DISABLED', details: `2FA disabled for user '${user.username}'.` });
    revalidatePath('/users');
}


export async function verifyTwoFactorToken(userId: string, token: string) {
  const user = await db.getUserById(userId);
  if (!user || !user.twoFactorSecret) {
    return false;
  }
  const isValid = authenticator.verify({ token, secret: user.twoFactorSecret });
  if (!isValid) {
    await writeLog({ level: 'WARN', actor: user.username, action: '2FA_VERIFICATION_FAILED', details: `User '${user.username}' submitted an invalid 2FA token.` });
  }
  return isValid;
}


export async function checkWriteAccess(): Promise<{ canWrite: boolean; error?: string }> {
  const { import: importPath, failed: failedPath } = await db.getMonitoredPaths();

  if (!importPath.path || !failedPath.path) {
    return { canWrite: false, error: 'Monitored paths are not configured in Settings.' };
  }

  try {
    const testFileImport = path.join(importPath.path, `.write_test_${Date.now()}`);
    await fs.writeFile(testFileImport, 'test');
    await fs.unlink(testFileImport);
  } catch (error: any) {
    if (error.code === 'EACCES') {
      return { canWrite: false, error: `Permission denied on the Import folder. The application cannot create files in "${importPath.path}".` };
    }
    if (error.code === 'ENOENT') {
      return { canWrite: false, error: `The Import folder path does not exist: "${importPath.path}". Please verify the path in Settings.` };
    }
    return { canWrite: false, error: `An unexpected error occurred with the Import folder: ${error.message}` };
  }

  try {
    const testFileFailed = path.join(failedPath.path, `.write_test_${Date.now()}`);
    await fs.writeFile(testFileFailed, 'test');
    await fs.unlink(testFileFailed);
  } catch (error: any) {
    if (error.code === 'EACCES') {
      return { canWrite: false, error: `Permission denied on the Failed folder. The application cannot create files in "${failedPath.path}".` };
    }
    if (error.code === 'ENOENT') {
      return { canWrite: false, error: `The Failed folder path does not exist: "${failedPath.path}". Please verify the path in Settings.` };
    }
    return { canWrite: false, error: `An unexpected error occurred with the Failed folder: ${error.message}` };
  }

  return { canWrite: true };
}


export async function testPath(path: string): Promise<{ success: boolean; error?: string }> {
    try {
        await fs.access(path);
        return { success: true };
    } catch (error: any) {
        if (error.code === 'ENOENT') {
            return { success: false, error: `Path does not exist: ${path}` };
        }
        if (error.code === 'EACCES') {
            return { success: false, error: `Permission denied: ${path}` };
        }
        return { success: false, error: `An unexpected error occurred: ${error.message}` };
    }
}

export async function retryFile(fileName: string, username: string): Promise<{ success: boolean; error?: string }> {
    const { import: importPath, failed: failedPath } = await db.getMonitoredPaths();
    const oldPath = path.join(failedPath.path, fileName);
    const newPath = path.join(importPath.path, fileName);

    try {
        await fs.access(oldPath);
        await fs.rename(oldPath, newPath);

        let fileStatus = await db.getFileStatusByName(fileName);
        if (fileStatus) {
            fileStatus.status = 'processing';
            fileStatus.lastUpdated = new Date().toISOString();
            fileStatus.remarks = `Retrying file. [user: ${username}]`;
            await db.upsertFileStatus(fileStatus);
        }
        
        await writeLog({ level: 'AUDIT', actor: username, action: 'FILE_RETRY', details: `File '${fileName}' was moved from failed to import for retry.` });
        revalidatePath('/dashboard');
        revalidatePath('/logs');
        return { success: true };
    } catch (error: any) {
        console.error(`Error retrying file ${fileName}:`, error);
        await writeLog({ level: 'ERROR', actor: username, action: 'FILE_RETRY_FAILED', details: `Attempted to retry file '${fileName}'. Error: ${error.message}` });
        revalidatePath('/logs');
        if (error.code === 'EACCES') {
             return { success: false, error: `Permission Denied: The application user does not have write permissions to move files between the 'import' and 'failed' directories. Please check folder permissions on the server.` };
        }
        if (error.code === 'ENOENT') {
            return { success: false, error: `File not found in failed directory: ${fileName}` };
        }
        return { success: false, error: `An unexpected error occurred: ${error.message}` };
    }
}

export async function renameFile(oldName: string, newName: string, username: string): Promise<{ success: boolean; error?: string }> {
    const { import: importPath, failed: failedPath } = await db.getMonitoredPaths();
    const oldPath = path.join(failedPath.path, oldName);
    const newPath = path.join(importPath.path, newName);

    try {
        await fs.access(oldPath);
        try {
            await fs.access(newPath);
            return { success: false, error: `A file named "${newName}" already exists in the import directory.` };
        } catch (e) {}

        await fs.rename(oldPath, newPath);
        await db.deleteFileStatus(oldName);
        
        const newFileStatus: FileStatus = {
            id: `file-${Date.now()}-${Math.random()}`,
            name: newName,
            status: 'processing',
            source: importPath.name,
            lastUpdated: new Date().toISOString(),
            remarks: `Renamed from "${oldName}" and retrying. [user: ${username}]`
        };
        await db.upsertFileStatus(newFileStatus);
        
        await writeLog({ level: 'AUDIT', actor: username, action: 'FILE_RENAME_AND_RETRY', details: `File '${oldName}' was renamed to '${newName}' and moved to import.` });
        revalidatePath('/dashboard');
        revalidatePath('/logs');
        return { success: true };
    } catch (error: any) {
        console.error(`Error renaming and moving file ${oldName}:`, error);
        await writeLog({ level: 'ERROR', actor: username, action: 'FILE_RENAME_FAILED', details: `Attempted to rename '${oldName}' to '${newName}'. Error: ${error.message}` });
        revalidatePath('/logs');
        if (error.code === 'EACCES') {
             return { success: false, error: `Permission Denied: The application user does not have write permissions to move files from the 'failed' to the 'import' directory. Please check folder permissions on the server.` };
        }
        if (error.code === 'ENOENT') {
            return { success: false, error: `File not found to rename: ${oldName}` };
        }
        return { success: false, error: `An unexpected error occurred: ${error.message}` };
    }
}

export async function deleteFailedFile(fileName: string): Promise<{ success: boolean; error?: string }> {
    const { failed: failedPath } = await db.getMonitoredPaths();
    const filePath = path.join(failedPath.path, fileName);
    
    try {
        await fs.unlink(filePath);
        await db.deleteFileStatus(fileName);
        await writeLog({ level: 'AUDIT', actor: 'system', action: 'FILE_DELETED', details: `Permanently deleted file '${fileName}' from the failed directory.` });
        revalidatePath('/dashboard');
        revalidatePath('/logs');
        return { success: true };
    } catch (error: any) {
        console.error(`Error deleting file ${fileName}:`, error);
        await writeLog({ level: 'ERROR', actor: 'system', action: 'FILE_DELETE_FAILED', details: `Attempted to delete file '${fileName}'. Error: ${error.message}` });
        revalidatePath('/logs');
        if (error.code === 'ENOENT') {
            await db.deleteFileStatus(fileName);
            revalidatePath('/dashboard');
            return { success: true, error: 'File was not found on disk, but its status entry was removed.' };
        }
         if (error.code === 'EACCES') {
             return { success: false, error: `Permission Denied: The application user does not have write permissions to delete files from the 'failed' directory.` };
        }
        return { success: false, error: `An unexpected error occurred: ${error.message}` };
    }
}

export async function expandFilePrefixes(fileName: string, username: string): Promise<{ success: boolean; count?: number; error?: string }> {
    const { import: importPath, failed: failedPath } = await db.getMonitoredPaths();
    const originalFilePath = path.join(failedPath.path, fileName);
    const fileExt = path.extname(fileName);
    const baseName = path.basename(fileName, fileExt);
    
    try {
        await fs.access(originalFilePath);
    } catch {
        return { success: false, error: `File not found in failed directory: ${fileName}` };
    }

    const parts = baseName.split('_');
    if (parts.length !== 4) {
        return { success: false, error: 'Filename does not match the required format for expansion.' };
    }

    const prefixPairsStr = parts[0];
    const validPairs: string[] = [];
    if (prefixPairsStr.length > 0 && prefixPairsStr.length % 2 === 0) {
        for (let i = 0; i < prefixPairsStr.length; i += 2) {
            if (['P', 'B', 'C'].includes(prefixPairsStr[i].toUpperCase())) {
                validPairs.push(prefixPairsStr.substring(i, i + 2));
            }
        }
    }

    if (validPairs.length <= 1) {
        return { success: false, error: 'File does not contain multiple valid prefixes to expand.' };
    }

    let allCopiesSucceeded = true;
    const newFilesToUpsert: FileStatus[] = [];

    for (const pair of validPairs) {
        const newFileName = `${pair}_${parts[1]}_${parts[2]}_${parts[3]}${fileExt}`;
        const newFilePath = path.join(importPath.path, newFileName);
        try {
            await fs.copyFile(originalFilePath, newFilePath);
            newFilesToUpsert.push({
                id: `file-${Date.now()}-${Math.random()}`,
                name: newFileName,
                status: 'processing',
                source: importPath.name,
                lastUpdated: new Date().toISOString(),
                remarks: `Expanded from ${fileName}. [user: ${username}]`
            });
        } catch (copyError) {
            console.error(`[Action] ERROR: Failed to create copy "${newFileName}":`, copyError);
            allCopiesSucceeded = false;
            // Attempt to clean up already created files
            for (const fileToClean of newFilesToUpsert) {
                try { await fs.unlink(path.join(importPath.path, fileToClean.name)); } catch {}
            }
            return { success: false, error: `Failed to create copy: ${newFileName}. Expansion aborted.` };
        }
    }

    if (allCopiesSucceeded) {
        try {
            await fs.unlink(originalFilePath);
            await db.deleteFileStatus(fileName);
            await db.bulkUpsertFileStatuses(newFilesToUpsert);
            await writeLog({ level: 'AUDIT', actor: username, action: 'FILE_EXPAND', details: `File '${fileName}' was expanded into ${validPairs.length} new files.` });
            revalidatePath('/dashboard');
            revalidatePath('/logs');
            return { success: true, count: validPairs.length };
        } catch (deleteError) {
            console.error(`[Action] ERROR: Failed to delete original expanded file "${fileName}":`, deleteError);
             await writeLog({ level: 'ERROR', actor: username, action: 'FILE_EXPAND_FAILED', details: `Failed to delete original file '${fileName}' after expansion. Error: ${deleteError}` });
             revalidatePath('/logs');
            return { success: false, error: `Failed to delete original file after expansion.` };
        }
    }

    return { success: false, error: 'An unknown error occurred during expansion.' };
}

export async function updateBrandingSettings(settings: BrandingSettings) {
  await writeLog({ level: 'AUDIT', actor: 'system', action: 'SETTINGS_UPDATE_BRANDING', details: `Branding updated: Name=${settings.brandName}` });
  await db.updateBranding(settings);
  revalidatePath('/settings');
  revalidatePath('/', 'layout');
  revalidatePath('/logs');
}

export async function updateSmtpSettings(settings: SmtpSettings) {
    await writeLog({ level: 'AUDIT', actor: 'system', action: 'SETTINGS_UPDATE_SMTP', details: `SMTP settings updated for host: ${settings.host}` });
    await db.updateSmtpSettings(settings);
    revalidatePath('/settings');
    revalidatePath('/logs');
}

export async function testSmtpConnection(): Promise<{success: boolean, error?: string}> {
    const smtpSettings = await db.getSmtpSettings();

    if (!smtpSettings.host) {
        return { success: false, error: "SMTP host is not configured." };
    }

    const transporter = nodemailer.createTransport({
        host: smtpSettings.host,
        port: smtpSettings.port,
        secure: smtpSettings.secure,
        auth: {
            user: smtpSettings.auth.user,
            pass: smtpSettings.auth.pass
        },
    });

    try {
        await transporter.verify();
        await writeLog({ level: 'INFO', actor: 'system', action: 'SMTP_TEST_SUCCESS', details: `Successfully connected to SMTP host: ${smtpSettings.host}` });
        revalidatePath('/logs');
        return { success: true };
    } catch (error: any) {
        await writeLog({ level: 'ERROR', actor: 'system', action: 'SMTP_TEST_FAILED', details: `Failed to connect to SMTP host: ${smtpSettings.host}. Error: ${error.message}` });
        revalidatePath('/logs');
        return { success: false, error: `Connection failed: ${error.message}` };
    }
}

export async function sendPasswordResetEmail(userId: string): Promise<{ success: boolean; error?: string }> {
    const user = await db.getUserById(userId);
    const smtpSettings = await db.getSmtpSettings();
    const branding = await db.getBranding();

    if (!user) return { success: false, error: "User not found." };
    if (!user.email) return { success: false, error: "User does not have a registered email address." };
    if (!smtpSettings.host) return { success: false, error: "SMTP is not configured. Cannot send email." };

    const tempPassword = Math.random().toString(36).slice(-8);
    await db.updateUserPassword(user.id, tempPassword);

    const transporter = nodemailer.createTransport({
        host: smtpSettings.host,
        port: smtpSettings.port,
        secure: smtpSettings.secure,
        auth: smtpSettings.auth,
    });

    const mailOptions = {
        from: `"${branding.brandName}" <${smtpSettings.auth.user}>`,
        to: user.email,
        subject: `Password Reset for ${branding.brandName}`,
        html: `<p>Hello ${user.name},</p><p>Your password has been reset by an administrator.</p><p>Your temporary password is: <strong>${tempPassword}</strong></p><p>Please log in and change your password immediately from your profile settings.</p><p>Thank you,</p><p>The ${branding.brandName} Team</p>`
    };

    try {
        await transporter.sendMail(mailOptions);
        await writeLog({ level: 'AUDIT', actor: 'system', action: 'PASSWORD_RESET_EMAIL_SENT', details: `Sent password reset email to user '${user.username}' at ${user.email}.` });
        revalidatePath('/logs');
        return { success: true };
    } catch (error: any) {
        console.error("Failed to send password reset email:", error);
        await writeLog({ level: 'ERROR', actor: 'system', action: 'PASSWORD_RESET_EMAIL_FAILED', details: `Failed to send reset email to '${user.username}'. Error: ${error.message}` });
        revalidatePath('/logs');
        return { success: false, error: `Failed to send email: ${error.message}` };
    }
}

export async function resetUserPasswordByAdmin(userId: string, newPassword: string): Promise<{ success: boolean, error?: string }> {
    try {
        const user = await db.getUserById(userId);
        if (!user) throw new Error("User not found");
        await db.updateUserPassword(userId, newPassword);
        await writeLog({ level: 'AUDIT', actor: 'system', action: 'ADMIN_PASSWORD_RESET', details: `Admin manually reset password for user '${user.username}'.` });
        revalidatePath('/logs');
        return { success: true };
    } catch (error: any) {
        console.error(`Failed to reset password for user ${userId}:`, error);
        await writeLog({ level: 'ERROR', actor: 'system', action: 'ADMIN_PASSWORD_RESET_FAILED', details: `Failed to reset password for user ID '${userId}'. Error: ${error.message}` });
        revalidatePath('/logs');
        return { success: false, error: 'An unexpected error occurred.' };
    }
}

export async function addUser(newUser: User): Promise<{ success: boolean, message?: string }> {
  const result = await db.addUser(newUser);
  if (result.success) {
    await writeLog({ level: 'AUDIT', actor: 'system', action: 'USER_CREATED', details: `New user created: '${newUser.username}' with role '${newUser.role}'.` });
    revalidatePath('/users');
    revalidatePath('/logs');
    return { success: true };
  }
  return { success: false, message: "A user with this username or email already exists." };
}

export async function removeUser(userId: string) {
    const user = await db.getUserById(userId);
    if (user) {
        await writeLog({ level: 'AUDIT', actor: 'system', action: 'USER_REMOVED', details: `User '${user.username}' was removed.` });
    }
    await db.removeUser(userId);
    revalidatePath('/users');
    revalidatePath('/logs');
}

export async function updateUser(user: User) {
    await writeLog({ level: 'AUDIT', actor: 'system', action: 'USER_UPDATED', details: `User details for '${user.username}' were updated.` });
    await db.updateUser(user);
    revalidatePath('/users');
    revalidatePath('/logs');
}

export async function updateMonitoredPaths(paths: MonitoredPaths) {
  await writeLog({ level: 'AUDIT', actor: 'system', action: 'SETTINGS_UPDATE_PATHS', details: `Monitored paths updated. Import: '${paths.import.path}', Failed: '${paths.failed.path}'.` });
  await db.updateMonitoredPaths(paths);
  revalidatePath('/settings');
  revalidatePath('/logs');
}

export async function addMonitoredExtension(extension: string) {
    const extensions = await db.getMonitoredExtensions();
    if (!extensions.includes(extension)) {
        extensions.push(extension);
        await db.updateMonitoredExtensions(extensions);
        await writeLog({ level: 'AUDIT', actor: 'system', action: 'SETTINGS_ADD_EXTENSION', details: `Added monitored extension: '.${extension}'.` });
        revalidatePath('/settings');
        revalidatePath('/logs');
    }
}

export async function removeMonitoredExtension(extension: string) {
    let extensions = await db.getMonitoredExtensions();
    extensions = extensions.filter(e => e !== extension);
    await db.updateMonitoredExtensions(extensions);
    await writeLog({ level: 'AUDIT', actor: 'system', action: 'SETTINGS_REMOVE_EXTENSION', details: `Removed monitored extension: '.${extension}'.` });
    revalidatePath('/settings');
    revalidatePath('/logs');
}

export async function updateFailureRemark(remark: string) {
    await writeLog({ level: 'AUDIT', actor: 'system', action: 'SETTINGS_UPDATE_FAILURE_REMARK', details: `Global failure remark updated.` });
    await db.updateFailureRemark(remark);
    revalidatePath('/settings');
    revalidatePath('/logs');
}

export async function updateCleanupSettings(settings: CleanupSettings) {
    await writeLog({ level: 'AUDIT', actor: 'system', action: 'SETTINGS_UPDATE_CLEANUP', details: `Cleanup settings updated.` });
    await db.updateCleanupSettings(settings);
    revalidatePath('/settings');
    revalidatePath('/logs');
}

export async function updateProcessingSettings(settings: ProcessingSettings) {
    await writeLog({ level: 'AUDIT', actor: 'system', action: 'SETTINGS_UPDATE_PROCESSING', details: `File processing settings updated.` });
    await db.updateProcessingSettings(settings);
    revalidatePath('/settings');
    revalidatePath('/logs');
}

export async function updateMaintenanceSettings(settings: MaintenanceSettings) {
    const action = settings.enabled ? 'MAINTENANCE_MODE_ENABLED' : 'MAINTENANCE_MODE_DISABLED';
    const details = `Maintenance mode was ${settings.enabled ? 'enabled' : 'disabled'}.`;
    await writeLog({ level: 'AUDIT', actor: 'system', action, details });
    await db.updateMaintenanceSettings(settings);
    revalidatePath('/settings');
    revalidatePath('/maintenance');
    revalidatePath('/logs');
}

export async function clearAllFileStatuses() {
    await writeLog({ level: 'AUDIT', actor: 'system', action: 'DB_CLEAR_FILE_STATUSES', details: `All file statuses were cleared from the database.` });
    await db.deleteAllFileStatuses();
    revalidatePath('/dashboard');
    revalidatePath('/logs');
}

export async function exportFileStatusesToCsv(): Promise<{ csv?: string; error?: string }> {
    try {
        const statuses = await db.getFileStatuses();
        if (statuses.length === 0) {
            return { error: "There are no file statuses to export." };
        }
        const csv = Papa.unparse(statuses);
        await writeLog({ level: 'INFO', actor: 'system', action: 'EXPORT_FILE_STATUSES', details: `Exported ${statuses.length} file status records.` });
        revalidatePath('/logs');
        return { csv };
    } catch (error: any) {
        console.error("Error exporting CSV:", error);
        await writeLog({ level: 'ERROR', actor: 'system', action: 'EXPORT_FAILED', details: `File status export failed: ${error.message}` });
        revalidatePath('/logs');
        return { error: "An unexpected error occurred during export." };
    }
}

export async function importFileStatusesFromCsv(csvContent: string): Promise<{ importedCount?: number; error?: string }> {
    try {
        const result = Papa.parse<FileStatus>(csvContent, { header: true, skipEmptyLines: true });

        if (result.errors.length > 0) {
            console.error("CSV Parsing errors:", result.errors);
            return { error: `Error parsing CSV on row ${result.errors[0].row}: ${result.errors[0].message}` };
        }

        const requiredFields = ['id', 'name', 'status', 'source', 'lastUpdated'];
        if (!result.meta.fields || !requiredFields.every(field => result.meta.fields!.includes(field))) {
            return { error: `CSV must contain the following columns: ${requiredFields.join(', ')}` };
        }

        const statusesToImport: FileStatus[] = result.data.map(row => ({
            ...row,
            remarks: row.remarks || '',
        }));

        await db.bulkUpsertFileStatuses(statusesToImport);
        await writeLog({ level: 'AUDIT', actor: 'system', action: 'IMPORT_FILE_STATUSES', details: `Imported ${statusesToImport.length} file status records from CSV.` });
        revalidatePath('/dashboard');
        revalidatePath('/logs');
        return { importedCount: statusesToImport.length };
    } catch (error: any) {
        console.error("Error importing CSV:", error);
        await writeLog({ level: 'ERROR', actor: 'system', action: 'IMPORT_FAILED', details: `File status import failed: ${error.message}` });
        revalidatePath('/logs');
        return { error: `An unexpected error occurred during import: ${error.message}` };
    }
}

export async function exportUsersToCsv(): Promise<{ csv?: string; error?: string }> {
    try {
        const users = await db.getUsers();
        if (users.length === 0) {
            return { error: "There are no users to export." };
        }
        const csv = Papa.unparse(users);
        await writeLog({ level: 'AUDIT', actor: 'system', action: 'EXPORT_USERS', details: `Exported ${users.length} user records.` });
        revalidatePath('/logs');
        return { csv };
    } catch (error: any) {
        console.error("Error exporting users to CSV:", error);
        await writeLog({ level: 'ERROR', actor: 'system', action: 'EXPORT_FAILED', details: `User export failed: ${error.message}` });
        revalidatePath('/logs');
        return { error: "An unexpected error occurred during export." };
    }
}

export async function importUsersFromCsv(csvContent: string): Promise<{ importedCount?: number; error?: string }> {
    try {
        const result = Papa.parse<User>(csvContent, { header: true, skipEmptyLines: true });

        if (result.errors.length > 0) {
            console.error("CSV Parsing errors:", result.errors);
            return { error: `Error parsing CSV on row ${result.errors[0].row}: ${result.errors[0].message}` };
        }
        
        const requiredFields = ['id', 'username', 'name', 'role', 'password'];
        if (!result.meta.fields || !requiredFields.every(field => result.meta.fields!.includes(field))) {
            return { error: `CSV must contain the following columns: ${requiredFields.join(', ')}` };
        }

        const usersToImport = result.data.map(user => ({
            ...user,
            email: user.email || '',
            avatar: user.avatar || null,
            twoFactorRequired: user.twoFactorRequired === true || user.twoFactorRequired === "true" || user.twoFactorRequired === "1",
            twoFactorSecret: user.twoFactorSecret || null,
        }));

        await db.bulkUpsertUsersWithPasswords(usersToImport);
        await writeLog({ level: 'AUDIT', actor: 'system', action: 'IMPORT_USERS', details: `Imported ${usersToImport.length} user records from CSV.` });
        revalidatePath('/users');
        revalidatePath('/logs');
        return { importedCount: usersToImport.length };
    } catch (error: any) {
        console.error("Error importing users from CSV:", error);
        await writeLog({ level: 'ERROR', actor: 'system', action: 'IMPORT_FAILED', details: `User import failed: ${error.message}` });
        revalidatePath('/logs');
        return { error: `An unexpected error occurred during import: ${error.message}` };
    }
}

export async function generateStatisticsReport(): Promise<{ csv?: string; error?: string }> {
    try {
        const files = await db.getFileStatuses();
        const publishedFiles = files.filter(file => file.status === 'published');
        
        if (publishedFiles.length === 0) {
            return { error: "No published files available to generate a report." };
        }

        // Process data
        const dailyCounts: { [key: string]: number } = {};
        const weeklyCounts: { [key: string]: number } = {};
        const monthlyCounts: { [key: string]: number } = {};

        publishedFiles.forEach(file => {
            const date = parseISO(file.lastUpdated);
            const dailyKey = format(date, "yyyy-MM-dd");
            const weeklyKey = format(startOfWeek(date, { weekStartsOn: 1 }), "yyyy-MM-dd");
            const monthlyKey = format(startOfMonth(date), "yyyy-MM");

            dailyCounts[dailyKey] = (dailyCounts[dailyKey] || 0) + 1;
            weeklyCounts[weeklyKey] = (weeklyCounts[weeklyKey] || 0) + 1;
            monthlyCounts[monthlyKey] = (monthlyCounts[monthlyKey] || 0) + 1;
        });

        // Convert to arrays
        const dailyData = Object.entries(dailyCounts).map(([date, count]) => ({ period: 'Daily', date, count }));
        const weeklyData = Object.entries(weeklyCounts).map(([date, count]) => ({ period: 'Weekly', date: `Week of ${date}`, count }));
        const monthlyData = Object.entries(monthlyCounts).map(([date, count]) => ({ period: 'Monthly', date: format(parseISO(`${date}-01`), 'MMM yyyy'), count }));
        
        const summaryData = [...dailyData, ...weeklyData, ...monthlyData];

        // Format raw data
        const rawData = publishedFiles.map(f => ({
            period: 'Raw Data',
            fileName: f.name,
            publishedDate: f.lastUpdated,
            source: f.source,
        }));

        // Convert to CSV
        const summaryCsv = Papa.unparse(summaryData);
        const rawDataCsv = Papa.unparse(rawData);

        const finalCsv = `STATISTICS SUMMARY\n${summaryCsv}\n\nRAW PUBLISHED DATA\n${rawDataCsv}`;

        await writeLog({ level: 'INFO', actor: 'system', action: 'EXPORT_STATISTICS', details: `Generated statistics report.` });
        revalidatePath('/logs');
        return { csv: finalCsv };
    } catch (error: any) {
        console.error("Error generating statistics report:", error);
        await writeLog({ level: 'ERROR', actor: 'system', action: 'EXPORT_FAILED', details: `Statistics report generation failed: ${error.message}` });
        revalidatePath('/logs');
        return { error: "An unexpected error occurred during report generation." };
    }
}

export async function exportAllSettings(): Promise<{ settings?: string; error?: string }> {
    try {
        const fullDb = await db.readDb();
        
        const settingsToExport: Partial<Database> = {
            // Users are explicitly excluded
            branding: fullDb.branding,
            monitoredPaths: fullDb.monitoredPaths,
            monitoredExtensions: fullDb.monitoredExtensions,
            cleanupSettings: fullDb.cleanupSettings,
            processingSettings: fullDb.processingSettings,
            failureRemark: fullDb.failureRemark,
            smtpSettings: fullDb.smtpSettings,
            maintenanceSettings: fullDb.maintenanceSettings,
        };

        const jsonString = JSON.stringify(settingsToExport, null, 2);
        await writeLog({ level: 'AUDIT', actor: 'system', action: 'EXPORT_SETTINGS', details: `Exported all application settings.` });
        revalidatePath('/logs');
        return { settings: jsonString };
    } catch (error: any) {
        console.error("Error exporting settings:", error);
        await writeLog({ level: 'ERROR', actor: 'system', action: 'EXPORT_FAILED', details: `Settings export failed: ${error.message}` });
        revalidatePath('/logs');
        return { error: "An unexpected error occurred during export." };
    }
}

export async function importAllSettings(settings: Partial<Database>): Promise<{ success: boolean; error?: string }> {
    try {
        // Validate the structure of the imported settings
        if (!settings || typeof settings !== 'object') {
            return { success: false, error: 'Invalid settings file format.' };
        }
        
        if (settings.users) {
            return { success: false, error: 'Settings import should not contain user data. Please use the dedicated user import feature.' };
        }

        const dbWrites: Promise<any>[] = [];

        // Update each setting if it exists in the imported file
        if (settings.branding) dbWrites.push(db.updateBranding(settings.branding));
        if (settings.monitoredPaths) dbWrites.push(db.updateMonitoredPaths(settings.monitoredPaths));
        if (settings.monitoredExtensions) dbWrites.push(db.updateMonitoredExtensions(settings.monitoredExtensions));
        if (settings.cleanupSettings) dbWrites.push(db.updateCleanupSettings(settings.cleanupSettings));
        if (settings.processingSettings) dbWrites.push(db.updateProcessingSettings(settings.processingSettings));
        if (settings.failureRemark) dbWrites.push(db.updateFailureRemark(settings.failureRemark));
        if (settings.smtpSettings) dbWrites.push(db.updateSmtpSettings(settings.smtpSettings));
        if (settings.maintenanceSettings) dbWrites.push(db.updateMaintenanceSettings(settings.maintenanceSettings));

        
        await Promise.all(dbWrites);
        
        await writeLog({ level: 'AUDIT', actor: 'system', action: 'IMPORT_SETTINGS', details: `Imported all application settings from a JSON file.` });
        revalidatePath('/settings');
        revalidatePath('/', 'layout');
        revalidatePath('/logs');

        return { success: true };
    } catch (error: any) {
        console.error("Error importing settings:", error);
        await writeLog({ level: 'ERROR', actor: 'system', action: 'IMPORT_FAILED', details: `Settings import failed: ${error.message}` });
        revalidatePath('/logs');
        return { success: false, error: 'An unexpected error occurred during the import process.' };
    }
}

export async function getLogs(): Promise<LogEntry[]> {
    return db.getLogs();
}

export async function exportLogsToCsv(logs: LogEntry[]): Promise<{ csv?: string; error?: string }> {
    try {
        if (!logs || logs.length === 0) {
            return { error: "There are no logs to export." };
        }
        const csv = Papa.unparse(logs);
        await writeLog({ level: 'INFO', actor: 'system', action: 'EXPORT_LOGS', details: `Exported ${logs.length} log records.` });
        revalidatePath('/logs');
        return { csv };
    } catch (error: any) {
        console.error("Error exporting logs:", error);
        await writeLog({ level: 'ERROR', actor: 'system', action: 'EXPORT_FAILED', details: `Log export failed: ${error.message}` });
        revalidatePath('/logs');
        return { error: "An unexpected error occurred during log export." };
    }
}
