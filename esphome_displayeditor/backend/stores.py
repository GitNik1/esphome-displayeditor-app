"""The stores one process opens once and shares.

The web app and its in-process assistant (help assistant, MCP apps) used to
open their own instance of every store. Both work on the same files, so
nothing was lost, but each copy had its own in-process locks and its own
audit pruning counter, and every SQLite file was initialized twice at
start-up. ``create_app`` now opens them once and hands them to the
assistant; the separate MCP listener process still opens its own.
"""

from __future__ import annotations

from dataclasses import dataclass

from .audit import AuditStore
from .designer import DesignerService
from .filesystem import FilesystemBackend
from .project_revisions import ProjectRevisionStore
from .project_store import ProjectStore
from .runtime.registry import DeviceRegistry
from .settings import Settings
from .viewer_bindings import ViewerBindingStore
from .workflow import WorkflowStore


@dataclass(frozen=True)
class Stores:
    designer: DesignerService
    filesystem: FilesystemBackend
    revisions: ProjectRevisionStore
    projects: ProjectStore
    audit: AuditStore
    workflow: WorkflowStore
    viewer_bindings: ViewerBindingStore
    device_registry: DeviceRegistry

    @classmethod
    def open(cls, settings: Settings) -> Stores:
        designer = DesignerService(settings.data_root)
        revisions = ProjectRevisionStore(settings.data_root)
        return cls(
            designer=designer,
            filesystem=FilesystemBackend(settings),
            revisions=revisions,
            projects=ProjectStore(
                settings.data_root, designer, settings.max_file_size, revisions=revisions
            ),
            audit=AuditStore(settings.data_root),
            workflow=WorkflowStore(settings.data_root),
            viewer_bindings=ViewerBindingStore(settings.data_root),
            device_registry=DeviceRegistry(settings.data_root),
        )
