
"use client";

import { useEffect, useState, useMemo, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FileStatusTable } from "@/components/file-status-table";
import { useAuth } from "@/hooks/use-auth";
import type { FileStatus } from "@/types";
import { Trash2, Search, X, CheckCircle2, AlertTriangle, Loader, Clock, Info, Trash, Upload, Download, FileUp, GitBranchPlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { clearAllFileStatuses, retryFile, renameFile, checkWriteAccess, deleteFailedFile, exportFileStatusesToCsv, importFileStatusesFromCsv, expandFilePrefixes } from "@/lib/actions";
import { readDb } from "@/lib/db";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isToday, isYesterday, parseISO } from "date-fns";


export default function DashboardPage() {
  const { user } = useAuth();
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState<FileStatus['status'] | 'all' | 'today' | 'yesterday'>('all');
  const [isPending, startTransition] = useTransition();
  const [isRenameDialogOpen, setIsRenameDialogOpen] = useState(false);
  const [fileToRename, setFileToRename] = useState<FileStatus | null>(null);
  const [newFileName, setNewFileName] = useState("");
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [fileToDelete, setFileToDelete] = useState<FileStatus | null>(null);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [writeAccessError, setWriteAccessError] = useState<string | null>(null);


  const { toast } = useToast();
  const [canWrite, setCanWrite] = useState(true);

  const fetchFiles = async () => {
    const db = await readDb();
    setFiles(db.fileStatuses);
  };

  useEffect(() => {
    fetchFiles();
    const intervalId = setInterval(fetchFiles, 5000); 
    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    async function verifyAccess() {
      const { canWrite, error } = await checkWriteAccess();
      setCanWrite(canWrite);
      setWriteAccessError(error || null);
    }
    verifyAccess();
  }, []);


  const handleClearAll = () => {
    startTransition(async () => {
      await clearAllFileStatuses();
      await fetchFiles();
      toast({
        title: "Database Cleared",
        description: "All file statuses have been removed.",
      });
    });
  };

  const handleRetry = (file: FileStatus) => {
    startTransition(async () => {
      if (!user) return;
      const result = await retryFile(file.name, user.username);
      if (result.success) {
        await fetchFiles();
        toast({
          title: "File Sent for Retry",
          description: `"${file.name}" has been moved back to the import folder.`,
        });
      } else {
        toast({
          title: "Retry Failed",
          description: result.error,
          variant: "destructive",
        });
      }
    });
  }

  const handleOpenRenameDialog = (file: FileStatus) => {
    setFileToRename(file);
    setNewFileName(file.name);
    setIsRenameDialogOpen(true);
  };
  
  const handleRename = () => {
    if (!fileToRename || !newFileName.trim() || !user) return;

    startTransition(async () => {
      const result = await renameFile(fileToRename.name, newFileName.trim(), user.username);
      await fetchFiles();
      if (result.success) {
        toast({
          title: "File Renamed & Retried",
          description: `"${fileToRename.name}" has been renamed and moved to the import folder.`,
        });
      } else {
        toast({
          title: "Rename Failed",
          description: result.error,
          variant: "destructive",
        });
      }
       setIsRenameDialogOpen(false);
       setFileToRename(null);
       setNewFileName("");
    });
  };

  const handleOpenDeleteDialog = (file: FileStatus) => {
    setFileToDelete(file);
    setIsDeleteDialogOpen(true);
  };

  const handleDelete = () => {
    if (!fileToDelete) return;

    startTransition(async () => {
      const result = await deleteFailedFile(fileToDelete.name);
      await fetchFiles();
      if (result.success) {
        toast({
          title: "File Deleted",
          description: `"${fileToDelete.name}" has been permanently deleted.`,
        });
      } else {
        toast({
          title: "Delete Failed",
          description: result.error,
          variant: "destructive",
        });
      }
      setIsDeleteDialogOpen(false);
      setFileToDelete(null);
    });
  };

  const handleExpand = (file: FileStatus) => {
    startTransition(async () => {
        if (!user) return;
        const result = await expandFilePrefixes(file.name, user.username);
        if (result.success) {
            await fetchFiles();
            toast({
                title: "File Expanded",
                description: `"${file.name}" was expanded into ${result.count} new files in the import folder.`,
            });
        } else {
            toast({
                title: "Expansion Failed",
                description: result.error,
                variant: "destructive",
            });
        }
    });
  };

  const handleExport = () => {
    startTransition(async () => {
      const { csv, error } = await exportFileStatusesToCsv();
      if (error) {
        toast({ title: "Export Failed", description: error, variant: "destructive" });
        return;
      }
      const blob = new Blob([csv!], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      const date = new Date().toISOString().slice(0, 10);
      link.setAttribute('download', `file-status-backup-${date}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast({ title: "Export Successful", description: "Your file status data has been downloaded." });
    });
  };

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.name.toLowerCase().endsWith('.csv')) {
        setImportError('Invalid file type. Please upload a CSV file.');
        setImportFile(null);
      } else {
        setImportFile(file);
        setImportError(null);
      }
    }
  };

  const handleImport = () => {
    if (!importFile) return;

    startTransition(async () => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const content = e.target?.result as string;
        const result = await importFileStatusesFromCsv(content);
        if (result.error) {
          toast({ title: "Import Failed", description: result.error, variant: "destructive", duration: 10000 });
        } else {
          toast({ title: "Import Successful", description: `${result.importedCount} records have been imported.` });
          await fetchFiles();
        }
        setIsImportDialogOpen(false);
        setImportFile(null);
        setImportError(null);
      };
      reader.readAsText(importFile);
    });
  };


  const filteredFiles = useMemo(() => {
    return files
      .filter(file => {
        if (activeFilter === 'all') return true;
        if (activeFilter === 'today') return isToday(parseISO(file.lastUpdated));
        if (activeFilter === 'yesterday') return isYesterday(parseISO(file.lastUpdated));
        return file.status === activeFilter;
      })
      .filter(file => file.name.toLowerCase().includes(searchTerm.toLowerCase()));
  }, [files, activeFilter, searchTerm]);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeFilter, searchTerm, itemsPerPage]);

  const totalPages = itemsPerPage > 0 ? Math.ceil(filteredFiles.length / itemsPerPage) : 1;
  const paginatedFiles = useMemo(() => {
     if (itemsPerPage === 0) {
      return filteredFiles;
    }
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    return filteredFiles.slice(startIndex, endIndex);
  }, [filteredFiles, currentPage, itemsPerPage]);

  const statusCounts = useMemo(() => {
    return files.reduce((acc, file) => {
      acc[file.status] = (acc[file.status] || 0) + 1;
      return acc;
    }, {} as Record<FileStatus['status'], number>);
  }, [files]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="space-y-6"
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-muted-foreground">
            Real-time status of all monitored files.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
           {user?.role === 'admin' && (
            <>
              <Button variant="outline" onClick={() => setIsImportDialogOpen(true)} disabled={isPending}>
                <Upload className="mr-2 h-4 w-4" />
                Import from CSV
              </Button>
              <Button variant="outline" onClick={handleExport} disabled={isPending}>
                <Download className="mr-2 h-4 w-4" />
                {isPending ? "Exporting..." : "Export to CSV"}
              </Button>
              <Button variant="destructive" onClick={handleClearAll} disabled={isPending}>
                  <Trash2 className="mr-2 h-4 w-4" />
                  {isPending ? "Clearing..." : "Clear All"}
              </Button>
            </>
           )}
        </div>
      </div>

       <div className="grid grid-cols-2 gap-2 md:gap-4 lg:grid-cols-4">
          <Card className="bg-yellow-500/20 dark:bg-yellow-500/10 border-yellow-500 text-yellow-900 dark:text-yellow-200">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 md:p-4">
              <CardTitle className="text-xs font-medium">Processing</CardTitle>
              <Loader className="h-4 w-4 text-yellow-500 animate-spin" />
            </CardHeader>
            <CardContent className="p-2 pt-0 md:p-4 md:pt-0">
                <div className="text-lg md:text-2xl font-bold">{statusCounts.processing || 0}</div>
            </CardContent>
          </Card>
          <Card className="bg-green-500/20 dark:bg-green-500/10 border-green-500 text-green-900 dark:text-green-200">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 md:p-4">
              <CardTitle className="text-xs font-medium">Published</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent className="p-2 pt-0 md:p-4 md:pt-0">
                <div className="text-lg md:text-2xl font-bold">{statusCounts.published || 0}</div>
            </CardContent>
          </Card>
          <Card className="bg-red-500/20 dark:bg-red-500/10 border-red-500 text-red-900 dark:text-red-200">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 md:p-4">
              <CardTitle className="text-xs font-medium">Failed</CardTitle>
              <AlertTriangle className="h-4 w-4 text-red-500" />
            </CardHeader>
            <CardContent className="p-2 pt-0 md:p-4 md:pt-0">
                 <div className="text-lg md:text-2xl font-bold">{statusCounts.failed || 0}</div>
            </CardContent>
          </Card>
          <Card className="bg-orange-500/20 dark:bg-orange-500/10 border-orange-500 text-orange-900 dark:text-orange-200">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 p-2 md:p-4">
              <CardTitle className="text-xs font-medium">Timed-out</CardTitle>
              <Clock className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent className="p-2 pt-0 md:p-4 md:pt-0">
                 <div className="text-lg md:text-2xl font-bold">{statusCounts['timed-out'] || 0}</div>
            </CardContent>
          </Card>
       </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>
                File Status
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                    (Showing {filteredFiles.length} files)
                </span>
            </CardTitle>
             <div className="flex items-center gap-4">
                 <div className="flex items-center gap-4">
                    <span className="text-sm text-muted-foreground">
                        Page {currentPage} of {totalPages}
                    </span>
                    <div className="flex items-center gap-2">
                        <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                        disabled={currentPage === 1}
                        >
                        Previous
                        </Button>
                        <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage((prev) => Math.min(prev + 1, totalPages))}
                        disabled={currentPage === totalPages}
                        >
                        Next
                        </Button>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Rows per page:</span>
                    <Select
                    value={itemsPerPage.toString()}
                    onValueChange={(value) => setItemsPerPage(Number(value))}
                    >
                    <SelectTrigger className="w-20">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="5">5</SelectItem>
                        <SelectItem value="10">10</SelectItem>
                        <SelectItem value="25">25</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                    </SelectContent>
                    </Select>
                </div>
            </div>
        </CardHeader>
        <CardContent>
          {!canWrite && (
            <Alert variant="destructive" className="mb-4">
              <Info className="h-4 w-4" />
              <AlertTitle>Configuration Error</AlertTitle>
              <AlertDescription>
                <p className="font-semibold">{writeAccessError || "An unknown error occurred."}</p>
                <p className="mt-2 text-xs">All folder-related actions are disabled. Please resolve the issue and refresh the page.</p>
              </AlertDescription>
            </Alert>
          )}
          <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by file name..."
                className="pl-10"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              {searchTerm && (
                <Button variant="ghost" size="icon" className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7" onClick={() => setSearchTerm('')}>
                   <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
                <Button size="sm" variant={activeFilter === 'all' ? 'default' : 'outline'} onClick={() => setActiveFilter('all')}>All</Button>
                <Button size="sm" variant={activeFilter === 'today' ? 'default' : 'outline'} onClick={() => setActiveFilter('today')}>Today</Button>
                <Button size="sm" variant={activeFilter === 'yesterday' ? 'default' : 'outline'} onClick={() => setActiveFilter('yesterday')}>Yesterday</Button>
                <Button size="sm" variant={activeFilter === 'processing' ? 'secondary' : 'outline'} className={activeFilter === 'processing' ? 'bg-yellow-500/80 text-white hover:bg-yellow-500/70' : ''} onClick={() => setActiveFilter('processing')}>Processing</Button>
                <Button size="sm" variant={activeFilter === 'published' ? 'secondary' : 'outline'} className={activeFilter === 'published' ? 'bg-green-500/80 text-white hover:bg-green-500/70' : ''} onClick={() => setActiveFilter('published')}>Published</Button>
                <Button size="sm" variant={activeFilter === 'failed' ? 'destructive' : 'outline'} onClick={() => setActiveFilter('failed')}>Failed</Button>
                <Button size="sm" variant={activeFilter === 'timed-out' ? 'secondary' : 'outline'} className={activeFilter === 'timed-out' ? 'bg-orange-500/80 text-white hover:bg-orange-500/70' : ''} onClick={() => setActiveFilter('timed-out')}>Timed-out</Button>
            </div>
          </div>
          <FileStatusTable
            files={paginatedFiles}
            onRetry={handleRetry}
            onRename={handleOpenRenameDialog}
            onDelete={handleOpenDeleteDialog}
            onExpand={handleExpand}
            isReadOnly={!canWrite}
            userRole={user?.role}
          />
        </CardContent>
      </Card>
      
       <Dialog open={isRenameDialogOpen} onOpenChange={setIsRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename & Retry File</DialogTitle>
            <DialogDescription>
              Enter a new name for the file. This will also move the file to the import folder to be processed again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Label htmlFor="new-file-name">New File Name</Label>
            <Input
              id="new-file-name"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="Enter new filename"
              disabled={isPending}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRenameDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleRename} disabled={isPending || !newFileName.trim()}>
              {isPending ? 'Processing...' : 'Rename & Retry'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you absolutely sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the file <span className="font-bold">"{fileToDelete?.name}"</span> from the rejected folder and remove its status from the dashboard.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isPending} className="bg-destructive hover:bg-destructive/90">
              {isPending ? 'Deleting...' : 'Yes, delete file'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={isImportDialogOpen} onOpenChange={setIsImportDialogOpen}>
          <DialogContent>
              <DialogHeader>
                  <DialogTitle>Import File Statuses from CSV</DialogTitle>
                  <DialogDescription>
                      Upload a CSV file to bulk update or add file statuses. The CSV must contain 'id', 'name', 'status', 'source', 'lastUpdated', and 'remarks' columns.
                  </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                  <div className="grid w-full max-w-sm items-center gap-1.5">
                      <Label htmlFor="csv-file">CSV File</Label>
                      <Input id="csv-file" type="file" accept=".csv" onChange={handleImportFileChange} />
                  </div>
                  {importError && (
                      <Alert variant="destructive">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertTitle>Error</AlertTitle>
                          <AlertDescription>{importError}</AlertDescription>
                      </Alert>
                  )}
              </div>
              <DialogFooter>
                  <Button variant="outline" onClick={() => setIsImportDialogOpen(false)}>Cancel</Button>
                  <Button onClick={handleImport} disabled={!importFile || isPending}>
                      {isPending ? 'Importing...' : 'Import'}
                  </Button>
              </DialogFooter>
          </DialogContent>
      </Dialog>
    </motion.div>
  );
}
