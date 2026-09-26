package srv

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gxhost/agent/internal/fsx"
)

// CurseForgeManifestFile contains only the immutable IDs inside a downloaded
// manifest. The Panel resolves these after checking the active operation, so a
// node never needs the CurseForge API key.
type CurseForgeManifestFile struct {
	ProjectID int64
	FileID    int64
}

type CurseForgeResolvedFile struct {
	ProjectID int64
	FileID    int64
	Filename  string
	Size      int64
	URL       string
	SHA1      string
	// Skip marks client-only content (resource packs, shaders) that the Panel
	// classified from the project's CurseForge class.
	Skip bool
}

type curseForgeManifest struct {
	Files []struct {
		ProjectID int64 `json:"projectID"`
		FileID    int64 `json:"fileID"`
		Required  bool  `json:"required"`
	} `json:"files"`
	Overrides string `json:"overrides"`
}

// InstallCurseForgeModpack preserves the same backup/staging/atomic-swap
// guarantees as InstallModpack. CurseForge archives contain a manifest rather
// than an .mrpack index, so the Agent validates that manifest and asks the
// Panel to resolve its listed file IDs into checksummed CDN downloads.
func (s *Server) InstallCurseForgeModpack(ctx context.Context, spec ModpackInstallSpec, resolve func(context.Context, []CurseForgeManifestFile) ([]CurseForgeResolvedFile, error), progress func(int, string)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.State != StateOffline {
		return fmt.Errorf("%w (current state: %s)", ErrServerNotStopped, s.State)
	}
	if err := allowedCurseForgeURL(spec.SourceURL); err != nil {
		return err
	}
	if spec.ExpectedSize <= 0 || spec.ExpectedSize > maxMrpackBytes {
		return fmt.Errorf("modpack: invalid package size")
	}

	dataDir := filepath.Join(s.node.DataDir, s.UUID)
	stageDir := dataDir + ".modpack-staging"
	oldDir := dataDir + ".modpack-old"
	archivePath := dataDir + ".modpack-download"
	_ = os.RemoveAll(stageDir)
	_ = os.RemoveAll(oldDir)
	_ = os.Remove(archivePath)
	defer os.Remove(archivePath)

	if err := downloadVerifiedWithPolicy(ctx, spec.SourceURL, archivePath, spec.ExpectedSize, spec.SHA1, spec.SHA512, allowedCurseForgeURL); err != nil {
		return err
	}
	zr, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("modpack: invalid CurseForge archive: %w", err)
	}
	defer zr.Close()
	if err := validateArchiveLimits(zr.File); err != nil {
		return err
	}
	manifest, err := readCurseForgeManifest(zr.File)
	if err != nil {
		return err
	}
	if err := validateCurseForgeEntries(zr.File, manifest.Overrides); err != nil {
		return err
	}

	required := make([]CurseForgeManifestFile, 0, len(manifest.Files))
	seen := make(map[int64]struct{}, len(manifest.Files))
	for _, file := range manifest.Files {
		if !file.Required {
			continue
		}
		if file.ProjectID <= 0 || file.FileID <= 0 {
			return fmt.Errorf("modpack: manifest contains an invalid CurseForge file reference")
		}
		if _, duplicate := seen[file.FileID]; duplicate {
			return fmt.Errorf("modpack: manifest repeats CurseForge file %d", file.FileID)
		}
		seen[file.FileID] = struct{}{}
		required = append(required, CurseForgeManifestFile{ProjectID: file.ProjectID, FileID: file.FileID})
	}
	if len(required) > 1_000 {
		return fmt.Errorf("modpack: manifest declares too many required files")
	}
	resolved, err := resolve(ctx, required)
	if err != nil {
		return fmt.Errorf("modpack: resolving CurseForge files: %w", err)
	}
	byID := make(map[int64]CurseForgeResolvedFile, len(resolved))
	for _, file := range resolved {
		if file.Skip && file.ProjectID > 0 && file.FileID > 0 {
			byID[file.FileID] = file
			continue
		}
		if file.ProjectID <= 0 || file.FileID <= 0 || file.Size <= 0 || file.SHA1 == "" || file.Filename == "" {
			return fmt.Errorf("modpack: Panel returned an incomplete CurseForge file")
		}
		if err := allowedCurseForgeURL(file.URL); err != nil {
			return err
		}
		if filepath.Base(file.Filename) != file.Filename || strings.Contains(file.Filename, "\\") {
			return fmt.Errorf("modpack: unsafe CurseForge filename %q", file.Filename)
		}
		byID[file.FileID] = file
	}
	if len(byID) != len(required) {
		return fmt.Errorf("modpack: Panel did not resolve every required CurseForge file")
	}

	progress(25, "Pacote validado; preparando staging")
	if err := copyTree(dataDir, stageDir, s.spec.UID); err != nil {
		return fmt.Errorf("modpack: preparing staging: %w", err)
	}
	stageJail, err := fsx.Open(stageDir)
	if err != nil {
		return err
	}
	defer stageJail.Close()

	var incoming int64
	for _, request := range required {
		file := byID[request.FileID]
		if file.ProjectID != request.ProjectID {
			return fmt.Errorf("modpack: Panel resolved CurseForge file %d to the wrong project", request.FileID)
		}
		if file.Skip {
			continue
		}
		if file.Size > maxExpandedBytes || incoming > maxExpandedBytes-file.Size {
			return fmt.Errorf("modpack: invalid or excessive CurseForge file %d", request.FileID)
		}
		incoming += file.Size
	}
	for _, file := range zr.File {
		if hasArchivePrefix(file.Name, manifest.Overrides) {
			incoming += int64(file.UncompressedSize64)
		}
	}
	if err := stageJail.CheckQuota(incoming, spec.DiskLimitMB); err != nil {
		return err
	}

	downloadedNames := make(map[string]struct{}, len(required))
	for i, request := range required {
		file := byID[request.FileID]
		if file.Skip {
			progress(30+(i+1)*50/max(1, len(required)), fmt.Sprintf("Ignorando conteúdo exclusivo de cliente (%d/%d)", i+1, len(required)))
			continue
		}
		nameKey := strings.ToLower(file.Filename)
		if _, duplicate := downloadedNames[nameKey]; duplicate {
			return fmt.Errorf("modpack: CurseForge manifest resolves duplicate filename %q", file.Filename)
		}
		downloadedNames[nameKey] = struct{}{}
		dest := filepath.Join(stageDir, "mods", file.Filename)
		if err := mkdirAllOwned(stageDir, filepath.Dir(dest), s.spec.UID); err != nil {
			return err
		}
		if err := downloadVerifiedWithPolicy(ctx, file.URL, dest, file.Size, file.SHA1, "", allowedCurseForgeURL); err != nil {
			return fmt.Errorf("modpack: file %q: %w", file.Filename, err)
		}
		clientOnly, err := isFabricClientOnlyMod(dest)
		if err != nil {
			return fmt.Errorf("modpack: inspect Fabric metadata for %q: %w", file.Filename, err)
		}
		if clientOnly {
			if err := os.Remove(dest); err != nil {
				return fmt.Errorf("modpack: remove client-only mod %q: %w", file.Filename, err)
			}
			progress(30+(i+1)*50/max(1, len(required)), fmt.Sprintf("Ignorando mod exclusivo de cliente (%d/%d)", i+1, len(required)))
			continue
		}
		if err := os.Chown(dest, s.spec.UID, s.spec.UID); err != nil {
			return err
		}
		progress(30+(i+1)*50/max(1, len(required)), fmt.Sprintf("Baixando arquivos do modpack (%d/%d)", i+1, len(required)))
	}
	if err := extractCurseForgeOverrides(zr.File, manifest.Overrides, stageDir, s.spec.UID); err != nil {
		return err
	}
	return s.activateModpackTree(dataDir, stageDir, oldDir, progress)
}

func allowedCurseForgeURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || (u.Hostname() != "edge.forgecdn.net" && u.Hostname() != "mediafilez.forgecdn.net") {
		return fmt.Errorf("download URL is not an allowed CurseForge CDN URL")
	}
	return nil
}

func readCurseForgeManifest(files []*zip.File) (*curseForgeManifest, error) {
	for _, file := range files {
		if file.Name != "manifest.json" {
			continue
		}
		if file.UncompressedSize64 > uint64(maxIndexBytes) {
			return nil, fmt.Errorf("modpack: manifest is too large")
		}
		r, err := file.Open()
		if err != nil {
			return nil, err
		}
		var manifest curseForgeManifest
		decodeErr := json.NewDecoder(r).Decode(&manifest)
		closeErr := r.Close()
		if decodeErr != nil {
			return nil, fmt.Errorf("modpack: invalid CurseForge manifest: %w", decodeErr)
		}
		if closeErr != nil {
			return nil, closeErr
		}
		if manifest.Overrides == "" || strings.HasPrefix(manifest.Overrides, "/") || strings.Contains(manifest.Overrides, "\\") {
			return nil, fmt.Errorf("modpack: invalid CurseForge overrides path")
		}
		if err := safeRelative(manifest.Overrides); err != nil {
			return nil, fmt.Errorf("modpack: invalid CurseForge overrides path: %w", err)
		}
		return &manifest, nil
	}
	return nil, fmt.Errorf("modpack: CurseForge manifest.json is missing")
}

func validateArchiveLimits(files []*zip.File) error {
	if len(files) > maxPackEntries {
		return fmt.Errorf("modpack: archive has too many entries")
	}
	var expanded int64
	for _, file := range files {
		if file.UncompressedSize64 > uint64(maxExpandedBytes) || expanded > maxExpandedBytes-int64(file.UncompressedSize64) {
			return fmt.Errorf("modpack: archive expands beyond the safety limit")
		}
		expanded += int64(file.UncompressedSize64)
		if file.UncompressedSize64 > 1<<20 && file.CompressedSize64 > 0 && file.UncompressedSize64/file.CompressedSize64 > maxCompressionRatio {
			return fmt.Errorf("modpack: archive entry %q exceeds the compression-ratio limit", file.Name)
		}
	}
	return nil
}

func validateCurseForgeEntries(files []*zip.File, overrides string) error {
	for _, file := range files {
		if file.FileInfo().IsDir() || (file.Name != "manifest.json" && !hasArchivePrefix(file.Name, overrides)) {
			continue
		}
		if err := validateArchiveEntry(file); err != nil {
			return err
		}
	}
	return nil
}

func validateArchiveEntry(file *zip.File) error {
	r, err := file.Open()
	if err != nil {
		return fmt.Errorf("modpack: pacote corrompido na entrada %q: %w", file.Name, err)
	}
	read, copyErr := io.Copy(io.Discard, io.LimitReader(r, int64(file.UncompressedSize64)+1))
	closeErr := r.Close()
	if copyErr != nil {
		return fmt.Errorf("modpack: pacote corrompido na entrada %q: %w", file.Name, copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("modpack: pacote corrompido na entrada %q: %w", file.Name, closeErr)
	}
	if read != int64(file.UncompressedSize64) {
		return fmt.Errorf("modpack: pacote corrompido na entrada %q: tamanho extraído inválido", file.Name)
	}
	return nil
}

func hasArchivePrefix(name, prefix string) bool {
	return strings.HasPrefix(name, strings.TrimSuffix(prefix, "/")+"/")
}

func extractCurseForgeOverrides(files []*zip.File, prefix, root string, uid int) error {
	prefix = strings.TrimSuffix(prefix, "/") + "/"
	for _, file := range files {
		if !strings.HasPrefix(file.Name, prefix) {
			continue
		}
		rel := strings.TrimPrefix(file.Name, prefix)
		if rel == "" {
			continue
		}
		if err := safeRelative(rel); err != nil {
			return err
		}
		if file.Mode()&(os.ModeSymlink|os.ModeDevice|os.ModeNamedPipe|os.ModeSocket) != 0 {
			return fmt.Errorf("modpack: unsafe archive entry %q", file.Name)
		}
		dest := filepath.Join(root, filepath.FromSlash(rel))
		if file.FileInfo().IsDir() {
			if err := mkdirAllOwned(root, dest, uid); err != nil {
				return err
			}
			continue
		}
		if err := mkdirAllOwned(root, filepath.Dir(dest), uid); err != nil {
			return err
		}
		r, err := file.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0640)
		if err != nil {
			r.Close()
			return err
		}
		written, copyErr := io.Copy(out, io.LimitReader(r, int64(file.UncompressedSize64)+1))
		closeErr := out.Close()
		_ = r.Close()
		if copyErr != nil {
			return copyErr
		}
		if written != int64(file.UncompressedSize64) {
			return fmt.Errorf("modpack: archive entry %q size mismatch", file.Name)
		}
		if closeErr != nil {
			return closeErr
		}
		if err := os.Chown(dest, uid, uid); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) activateModpackTree(dataDir, stageDir, oldDir string, progress func(int, string)) error {
	progress(85, "Validando e ativando os novos arquivos")
	if err := s.Jail.Close(); err != nil {
		return err
	}
	if err := os.Rename(dataDir, oldDir); err != nil {
		s.Jail, _ = fsx.Open(dataDir)
		return err
	}
	if err := os.Rename(stageDir, dataDir); err != nil {
		_ = os.Rename(oldDir, dataDir)
		s.Jail, _ = fsx.Open(dataDir)
		return err
	}
	newJail, err := fsx.Open(dataDir)
	if err != nil {
		return err
	}
	s.Jail = newJail
	go func() { time.Sleep(time.Hour); _ = os.RemoveAll(oldDir) }()
	progress(98, "Arquivos ativados")
	return nil
}
