import type {
  LocalBasis,
  ModelNode,
  SliceRanges,
  VolumeFace,
  WorkflowTab,
} from "./types";

export type SavedWorkspace = {
  version: 1;
  fileName: string;
  nodes: Array<Pick<ModelNode, "id" | "global">>;
  faces: VolumeFace[];
  activeTab: WorkflowTab;
  definingFaces: boolean;
  smartSelecting: boolean;
  draftNodeIds: number[];
  selectedFaceIds: string[];
  volumeConfirmed: boolean;
  floorFaceId: string | null;
  xDirectionNodeIds: number[];
  basis: LocalBasis | null;
  slice: SliceRanges;
  selectedNodeId: number | null;
};

const DATABASE_NAME = "mct-section-lab";
const STORE_NAME = "workspace";
const CURRENT_KEY = "current";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadWorkspace(): Promise<SavedWorkspace | null> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readonly")
        .objectStore(STORE_NAME)
        .get(CURRENT_KEY);
      request.onsuccess = () => {
        const value = request.result as SavedWorkspace | undefined;
        resolve(
          value?.version === 1 && Array.isArray(value.nodes) ? value : null,
        );
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export async function saveWorkspace(workspace: SavedWorkspace): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(workspace, CURRENT_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
