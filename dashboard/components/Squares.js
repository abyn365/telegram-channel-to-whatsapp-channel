export default function Squares({
  speed = 0.5,
  squareSize = 40,
  direction = 'diagonal',
  borderColor = '#999',
  hoverFillColor = '#222',
}) {
  return (
    <div
      className="squaresBackground"
      data-direction={direction}
      style={{
        '--sq-speed': `${Math.max(speed, 0.1) * 28}s`,
        '--sq-size': `${Math.max(squareSize, 12)}px`,
        '--sq-border': borderColor,
        '--sq-hover': hoverFillColor,
      }}
      aria-hidden="true"
    />
  );
}
