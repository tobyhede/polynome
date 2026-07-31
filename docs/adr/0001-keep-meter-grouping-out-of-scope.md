# Keep meter grouping out of scope

Polynome models each rhythm layer as a meter-relative grid: the meter supplies signature units, subdivision splits each unit into equal pulses, and the accent/hit/rest pattern expresses emphasis. We will not store or expose meter grouping such as `2+2+3`; separate grouping state or controls would duplicate the pattern and expand the metronome toward notation-editor scope without changing its timing calculations.
