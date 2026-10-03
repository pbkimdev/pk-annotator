import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

export const Route = createFileRoute("/game")({ component: Game });

const WIDTH = 640;
const HEIGHT = 420;
const PADDLE = { width: 96, height: 12, y: HEIGHT - 32 };
const BALL_RADIUS = 7;
const COLUMNS = 10;
const BRICK = { width: 56, height: 18, gap: 6, top: 56 };
const ROW_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7"];
const LIVES = 3;

const Score = z.strictObject({ player: z.string(), score: z.number(), level: z.number() });
const Ranked = z.strictObject({ rank: z.number(), top: z.array(Score) });
type Score = z.infer<typeof Score>;

type Phase = "ready" | "playing" | "paused" | "over" | "won";
type Brick = { x: number; y: number; color: string; alive: boolean };
type World = {
  paddle: number;
  ball: { x: number; y: number; dx: number; dy: number };
  bricks: Brick[];
  keys: Set<string>;
  score: number;
};

function layBricks(level: number): Brick[] {
  const rows = Math.min(3 + level, ROW_COLORS.length);
  const left = (WIDTH - COLUMNS * BRICK.width - (COLUMNS - 1) * BRICK.gap) / 2;
  return Array.from({ length: rows * COLUMNS }, (_, index) => {
    const row = Math.floor(index / COLUMNS);
    return {
      x: left + (index % COLUMNS) * (BRICK.width + BRICK.gap),
      y: BRICK.top + row * (BRICK.height + BRICK.gap),
      color: ROW_COLORS[row % ROW_COLORS.length] ?? "#888",
      alive: true,
    };
  });
}

function serve(world: World, level: number): void {
  const speed = 4 + level * 0.8;
  world.ball = { x: world.paddle, y: PADDLE.y - BALL_RADIUS - 1, dx: speed * 0.6, dy: -speed };
}

function Game() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<World>({
    paddle: WIDTH / 2,
    ball: { x: WIDTH / 2, y: PADDLE.y - BALL_RADIUS - 1, dx: 0, dy: 0 },
    bricks: layBricks(1),
    keys: new Set(),
    score: 0,
  });
  const submitted = useRef(false);
  const [phase, setPhase] = useState<Phase>("ready");
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(LIVES);
  const [level, setLevel] = useState(1);
  const [player, setPlayer] = useState("player");
  const [board, setBoard] = useState<Score[]>([]);
  const [rank, setRank] = useState<number | null>(null);

  // One animation loop, alive only while playing.
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    // A backing store at the device pixel ratio keeps demo recordings sharp.
    const ratio = window.devicePixelRatio;
    element.width = WIDTH * ratio;
    element.height = HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const state = world.current;
    let frame = 0;
    const draw = () => {
      context.fillStyle = "#0f172a";
      context.fillRect(0, 0, WIDTH, HEIGHT);
      for (const brick of state.bricks) {
        if (!brick.alive) continue;
        context.fillStyle = brick.color;
        context.beginPath();
        context.roundRect(brick.x, brick.y, BRICK.width, BRICK.height, 4);
        context.fill();
      }
      context.fillStyle = "#e2e8f0";
      context.beginPath();
      context.roundRect(state.paddle - PADDLE.width / 2, PADDLE.y, PADDLE.width, PADDLE.height, 6);
      context.fill();
      context.fillStyle = "#fbbf24";
      context.beginPath();
      context.arc(state.ball.x, state.ball.y, BALL_RADIUS, 0, Math.PI * 2);
      context.fill();
    };
    // Returns false when the board changes phase, level, or lives; the effect restarts.
    const step = (): boolean => {
      if (state.keys.has("ArrowLeft")) state.paddle -= 9;
      if (state.keys.has("ArrowRight")) state.paddle += 9;
      state.paddle = Math.max(PADDLE.width / 2, Math.min(WIDTH - PADDLE.width / 2, state.paddle));
      const ball = state.ball;
      ball.x += ball.dx;
      ball.y += ball.dy;
      if (ball.x < BALL_RADIUS || ball.x > WIDTH - BALL_RADIUS) ball.dx *= -1;
      if (ball.y < BALL_RADIUS) ball.dy = Math.abs(ball.dy);
      const offset = (ball.x - state.paddle) / (PADDLE.width / 2);
      if (
        ball.dy > 0 &&
        ball.y + BALL_RADIUS >= PADDLE.y &&
        ball.y < PADDLE.y + PADDLE.height &&
        Math.abs(offset) <= 1
      ) {
        const speed = Math.hypot(ball.dx, ball.dy);
        ball.dx = speed * offset * 0.8;
        ball.dy = -Math.sqrt(speed * speed - ball.dx * ball.dx);
      }
      for (const brick of state.bricks) {
        if (
          brick.alive &&
          ball.x > brick.x - BALL_RADIUS &&
          ball.x < brick.x + BRICK.width + BALL_RADIUS &&
          ball.y > brick.y - BALL_RADIUS &&
          ball.y < brick.y + BRICK.height + BALL_RADIUS
        ) {
          brick.alive = false;
          ball.dy *= -1;
          state.score += 10 * level;
          setScore(state.score);
          break;
        }
      }
      if (state.bricks.every((brick) => !brick.alive)) {
        console.info(`game: level ${level} cleared`);
        if (level === 3) setPhase("won");
        else {
          setLevel(level + 1);
          state.bricks = layBricks(level + 1);
          serve(state, level + 1);
        }
        return false;
      }
      if (ball.y > HEIGHT + BALL_RADIUS) {
        console.warn("game: ball lost", { x: Math.round(ball.x), lives: lives - 1 });
        if (lives === 1) setPhase("over");
        else serve(state, level);
        setLives(lives - 1);
        return false;
      }
      return true;
    };
    const tick = () => {
      const going = step();
      draw();
      if (going) frame = requestAnimationFrame(tick);
    };
    draw();
    if (phase === "playing") frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, level, lives]);

  useEffect(() => {
    const keys = world.current.keys;
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        keys.add(event.key);
        event.preventDefault();
      }
      if (event.key === " ") {
        event.preventDefault();
        setPhase((current) =>
          current === "playing" ? "paused" : current === "paused" ? "playing" : current,
        );
      }
    };
    const up = (event: KeyboardEvent) => keys.delete(event.key);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    void fetch("/api/scores")
      .then((response) => response.json())
      .then((body) => setBoard(z.array(Score).parse(body)))
      .catch((error) => console.error("game: leaderboard failed", error));
  }, []);

  useEffect(() => {
    if ((phase !== "over" && phase !== "won") || submitted.current) return;
    submitted.current = true;
    void fetch("/api/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ player, score, level }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`score returned ${response.status}`);
        return response.json();
      })
      .then((body) => {
        const ranked = Ranked.parse(body);
        setRank(ranked.rank);
        setBoard(ranked.top);
      })
      .catch((error) => console.error("game: score submit failed", error));
  }, [phase, player, score, level]);

  const start = () => {
    const state = world.current;
    state.bricks = layBricks(1);
    state.paddle = WIDTH / 2;
    serve(state, 1);
    state.score = 0;
    submitted.current = false;
    setScore(0);
    setLives(LIVES);
    setLevel(1);
    setRank(null);
    setPhase("playing");
    console.log("game: start", { player });
  };

  const aim = (clientX: number) => {
    const box = canvas.current?.getBoundingClientRect();
    if (box) world.current.paddle = ((clientX - box.left) / box.width) * WIDTH;
  };

  return (
    <main className="game" data-testid="game">
      <style>{STYLES}</style>
      <header>
        <h1 data-testid="game-title">Breakout</h1>
        <dl>
          <dt>Score</dt>
          <dd data-testid="game-score">{score}</dd>
          <dt>Lives</dt>
          <dd data-testid="game-lives">{"♥".repeat(lives)}</dd>
          <dt>Level</dt>
          <dd data-testid="game-level">{level}</dd>
        </dl>
      </header>
      <div className="stage">
        <canvas
          ref={canvas}
          width={WIDTH}
          height={HEIGHT}
          data-testid="game-canvas"
          aria-label="Breakout board"
          onPointerMove={(event) => aim(event.clientX)}
          onClick={() => phase === "ready" && start()}
        />
        {phase !== "playing" && (
          <div className="overlay" data-testid="game-overlay">
            <p>
              {phase === "ready" && "Move with the mouse or ← →"}
              {phase === "paused" && "Paused"}
              {phase === "over" && `Game over · ${score}`}
              {phase === "won" && `You win · ${score}`}
              {rank !== null && ` · #${rank}`}
            </p>
            {phase === "paused" ? (
              <button type="button" onClick={() => setPhase("playing")}>
                Resume
              </button>
            ) : (
              <button type="button" data-testid="game-start" onClick={start}>
                {phase === "ready" ? "Start" : "Play again"}
              </button>
            )}
          </div>
        )}
      </div>
      <aside>
        <label>
          Player <input value={player} onChange={(event) => setPlayer(event.target.value)} />
        </label>
        <h2>Leaderboard</h2>
        <ol data-testid="game-board">
          {board.map((entry, index) => (
            <li key={`${entry.player}-${entry.score}-${index}`}>
              <span>{entry.player}</span> <b>{entry.score}</b>
            </li>
          ))}
        </ol>
      </aside>
    </main>
  );
}

const STYLES = `
.game {
  display: grid; grid-template-columns: minmax(0, 1fr) 14rem; gap: 1rem; padding: 1rem;
  font: 14px/1.5 system-ui, sans-serif; color: #0f172a;
}
.game header { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 2rem; }
.game h1 { margin: 0; font-size: 1.5rem; }
.game dl { display: flex; gap: 0.4rem 1rem; margin: 0; }
.game dt { color: #64748b; }
.game dd { margin: 0 0.6rem 0 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.game .stage { position: relative; }
.game canvas { width: 100%; max-width: 640px; aspect-ratio: 640 / 420; border-radius: 12px; display: block; cursor: none; }
.game .overlay {
  position: absolute; inset: 0; max-width: 640px; display: grid; place-content: center; gap: 0.8rem;
  text-align: center; color: #f8fafc; background: rgb(15 23 42 / 0.6); border-radius: 12px;
}
.game .overlay p { margin: 0; font-size: 1.25rem; font-weight: 600; }
.game button {
  font: inherit; font-weight: 600; padding: 0.4rem 1.2rem; border-radius: 999px; border: 0;
  background: #fbbf24; color: #0f172a; cursor: pointer;
}
.game aside { display: grid; align-content: start; gap: 0.6rem; }
.game input { font: inherit; width: 8rem; margin-left: 0.4rem; }
.game h2 { margin: 0.6rem 0 0; font-size: 1rem; }
.game ol { margin: 0; padding-left: 1.4rem; }
.game li span { color: #475569; }
`;
