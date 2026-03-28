import React from 'react';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function DayPicker({ selected, onChange }) {
  const toggle = (day) => {
    if (selected.includes(day)) onChange(selected.filter((d) => d !== day));
    else onChange([...selected, day]);
  };

  return (
    <div>
      <div className="day-chips">
        {DAYS.map((day, i) => (
          <span
            key={day}
            className={`day-chip${selected.includes(day) ? ' on' : ''}`}
            onClick={() => toggle(day)}
          >
            {SHORT[i]}
          </span>
        ))}
      </div>
      <div className="day-chip-quick">
        <span className="day-chip" style={{ fontSize: 11 }} onClick={() => onChange([...DAYS])}>All</span>
        <span className="day-chip" style={{ fontSize: 11 }} onClick={() => onChange(['Monday','Tuesday','Wednesday','Thursday','Friday'])}>Weekdays</span>
        <span className="day-chip" style={{ fontSize: 11 }} onClick={() => onChange(['Saturday','Sunday'])}>Weekend</span>
        <span className="day-chip" style={{ fontSize: 11 }} onClick={() => onChange([])}>None</span>
      </div>
    </div>
  );
}
