import { useOp } from "millpond/react";
import { useState } from "react";
import { Modal } from "../Modal";
import { forfeitGame } from "../../features/game";

interface ForfeitControlProps {
  gameId: string;
  /** Who wins if the player gives up, as a sentence names them: "Grace", "Player 2". */
  opponent: string;
  /** Giving up is not possible right now, e.g. an action is waiting for its answer. */
  disabled: boolean;
}

/**
 * The quiet "Forfeit" button, and the question it asks first: giving up ends the game at once
 * and can't be taken back. The focus starts on "Keep playing", so that a stray Enter doesn't
 * give the game away.
 */
export function ForfeitControl({ gameId, opponent, disabled }: ForfeitControlProps) {
  const forfeit = useOp(forfeitGame);
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button
        className="button button-quiet button-small"
        type="button"
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        Forfeit
      </button>
      {asking && (
        <Modal title="Forfeit this game?" onClose={() => setAsking(false)}>
          <p>{opponent} wins the game. This can’t be undone.</p>
          <div className="modal-actions">
            <button className="button button-quiet" type="button" data-autofocus onClick={() => setAsking(false)}>
              Keep playing
            </button>
            <button
              className="button"
              type="button"
              onClick={() => {
                setAsking(false);
                forfeit({ gameId });
              }}
            >
              Forfeit
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
