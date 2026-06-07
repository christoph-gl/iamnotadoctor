"use client";

import { useState, useRef } from "react";
import { RIDER_PROFILE, type RiderProfile } from "@/lib/profile";
import { Workout, calculateWorkoutMetrics } from "@/lib/workouts";

function getColorForPower(power: number, riderProfile: RiderProfile) {
  if (power >= riderProfile.fourDP.ac * 0.95) return riderProfile.colors.nm;
  if (power >= riderProfile.fourDP.map * 0.95) return riderProfile.colors.ac;
  if (power >= riderProfile.fourDP.ftp * 1.05) return riderProfile.colors.map;
  return riderProfile.colors.ftp;
}

export function WorkoutChart({ 
  workout, 
  progressSeconds,
  onSeek,
  preview = false,
  riderProfile = RIDER_PROFILE,
  actualPowerSamples = [],
}: { 
  workout: Workout; 
  progressSeconds: number;
  onSeek?: (seconds: number) => void;
  preview?: boolean;
  riderProfile?: RiderProfile;
  actualPowerSamples?: Array<{ elapsedSeconds: number; power?: number }>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  const totalDuration = workout.blocks.reduce((acc, b) => acc + b.durationSeconds, 0);
  // Ensure the chart scales to at least one-minute power or the max power in the workout.
  const maxPower = Math.max(
    ...workout.blocks.map(b => b.targetPower),
    riderProfile.fourDP.ac * 1.1
  );
  
  const height = preview ? 100 : 300;
  const ftpY = height - (riderProfile.fourDP.ftp / maxPower) * height;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (preview || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, x / rect.width));
    setHoverTime(percent * totalDuration);
  };

  const handleMouseLeave = () => {
    setHoverTime(null);
  };

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (preview || !svgRef.current || !onSeek) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, x / rect.width));
    onSeek(Math.round(percent * totalDuration));
  };

  const metrics = calculateWorkoutMetrics(workout, riderProfile.fourDP.ftp);
  const powerLegend = [
    { label: "P5", color: riderProfile.colors.nm },
    { label: "P60", color: riderProfile.colors.ac },
    { label: "P300", color: riderProfile.colors.map },
    { label: "Threshold", color: riderProfile.colors.ftp },
  ];
  const chartBlocks = workout.blocks.reduce<
    Array<{ block: Workout["blocks"][number]; blockWidth: number; blockHeight: number; x: number; y: number; color: string }>
  >((segments, block) => {
    const previous = segments.at(-1);
    const x = previous ? previous.x + previous.blockWidth : 0;
    const blockWidth = (block.durationSeconds / totalDuration) * 100;
    const blockHeight = (block.targetPower / maxPower) * height;

    segments.push({
      block,
      blockWidth,
      blockHeight,
      x,
      y: height - blockHeight,
      color: getColorForPower(block.targetPower, riderProfile),
    });

    return segments;
  }, []);
  const powerTracePoints = actualPowerSamples
    .filter(
      (sample): sample is { elapsedSeconds: number; power: number } =>
        typeof sample.power === "number" &&
        sample.elapsedSeconds >= 0 &&
        sample.elapsedSeconds <= totalDuration
    )
    .map((sample) => ({
      x: (sample.elapsedSeconds / totalDuration) * 100,
      y: height - (Math.min(sample.power, maxPower) / maxPower) * height,
    }));
  const powerTracePath = powerTracePoints
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(3)} ${point.y.toFixed(3)}`)
    .join(" ");

  // Find hovered block
  let hoveredBlock = null;
  if (hoverTime !== null) {
    let acc = 0;
    for (const b of workout.blocks) {
      acc += b.durationSeconds;
      if (hoverTime <= acc) {
        hoveredBlock = b;
        break;
      }
    }
  }

  if (preview) {
    return (
      <div className="w-full h-12 relative bg-[#1a1a1a] rounded overflow-hidden">
        <svg className="w-full h-full" preserveAspectRatio="none" viewBox={`0 0 100 ${height}`}>
           <line 
            x1="0" 
            y1={ftpY} 
            x2="100" 
            y2={ftpY} 
            stroke="white" 
            strokeWidth="1" 
            strokeOpacity="0.3" 
          />
          {chartBlocks.map(({ x, y, blockWidth, blockHeight, color }, i) => (
            <rect
              key={i}
              x={x}
              y={y}
              width={blockWidth}
              height={blockHeight}
              fill={color}
            />
          ))}
        </svg>
      </div>
    );
  }

  return (
    <div className="w-full relative bg-[#202020] p-4 rounded-md border overflow-hidden">
      <div className="flex justify-between items-center mb-4">
        <div className="flex gap-6">
          <div className="flex flex-col">
            <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Duration</span>
            <span className="font-mono font-bold text-lg">{Math.floor(totalDuration / 60)}:{String(totalDuration % 60).padStart(2, '0')}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">TSS®</span>
            <span className="font-mono font-bold text-lg">{Math.round(metrics.tss)}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">IF®</span>
            <span className="font-mono font-bold text-lg">{metrics.iff.toFixed(2)}</span>
          </div>
        </div>
        <div className="text-right flex items-center gap-4">
          <div className="flex gap-1.5 items-center">
            {powerLegend.map(({ label, color }) => (
              <div key={label} className="flex items-center gap-1">
                <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">{label}</span>
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }}></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="relative w-full h-[300px] select-none group">
        <svg 
          ref={svgRef}
          className={`w-full h-full ${onSeek ? "cursor-pointer" : ""}`}
          preserveAspectRatio="none" 
          viewBox={`0 0 100 ${height}`}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
        >
          {/* Threshold line */}
          <line 
            x1="0" 
            y1={ftpY} 
            x2="100" 
            y2={ftpY} 
            stroke="white" 
            strokeWidth="0.5" 
            strokeOpacity="0.8" 
          />
          
          {chartBlocks.map(({ x, y, blockWidth, blockHeight, color }, i) => (
            <rect
              key={i}
              x={x}
              y={y}
              width={blockWidth}
              height={blockHeight}
              fill={color}
              stroke="#202020"
              strokeWidth="0.1"
            />
          ))}

          {powerTracePath && (
            <path
              d={powerTracePath}
              fill="none"
              stroke="white"
              strokeWidth="0.55"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity="0.95"
              style={{ pointerEvents: 'none' }}
            />
          )}

          {/* Progress Overlay */}
          {progressSeconds > 0 && (
             <rect 
               x="0" 
               y="0" 
               width={(progressSeconds / totalDuration) * 100} 
               height={height} 
               fill="white" 
               fillOpacity="0.15" 
               style={{ pointerEvents: 'none' }}
             />
          )}

          {/* Current Time Line */}
          {progressSeconds > 0 && progressSeconds < totalDuration && (
             <line 
               x1={(progressSeconds / totalDuration) * 100} 
               y1="0" 
               x2={(progressSeconds / totalDuration) * 100} 
               y2={height} 
               stroke="white" 
               strokeWidth="0.3" 
               style={{ pointerEvents: 'none' }}
             />
          )}

          {/* Hover Time Line */}
          {hoverTime !== null && (
             <line 
               x1={(hoverTime / totalDuration) * 100} 
               y1="0" 
               x2={(hoverTime / totalDuration) * 100} 
               y2={height} 
               stroke="rgba(255,255,255,0.5)" 
               strokeWidth="0.2"
               strokeDasharray="1 1"
               style={{ pointerEvents: 'none' }}
             />
          )}
        </svg>

        {/* Threshold label overlay */}
        <div 
          className="absolute left-2 px-2 py-0.5 bg-white text-black text-xs font-bold rounded-full shadow-sm pointer-events-none"
          style={{ top: `${(ftpY / height) * 100}%`, transform: 'translateY(-50%)' }}
        >
          {riderProfile.fourDP.ftp} W
        </div>

        {/* Hover Tooltip Overlay */}
        {hoverTime !== null && hoveredBlock && (
          <div 
            className="absolute px-2 py-1 bg-black/90 border border-white/20 text-white text-[10px] font-bold rounded shadow-md pointer-events-none transform -translate-x-1/2 -translate-y-full transition-opacity opacity-0 group-hover:opacity-100 flex flex-col items-center"
            style={{ 
              left: `${(hoverTime / totalDuration) * 100}%`,
              // Position it slightly above the hovered block's top edge
              top: `calc(${((height - (hoveredBlock.targetPower / maxPower) * height) / height) * 100}% - 10px)` 
            }}
          >
            <span>{hoveredBlock.targetPower} W</span>
            <span className="text-[9px] opacity-70 font-mono">
              {Math.floor(hoveredBlock.durationSeconds / 60)}:{String(hoveredBlock.durationSeconds % 60).padStart(2, '0')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
