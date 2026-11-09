//! The change from one JSON value to the next, written short when the two are alike. A game's
//! history keeps most of its states this way (see `history`): a step of a game changes a few
//! numbers of a state that has dozens.
//!
//! A delta is a JSON list of changes, in no particular order, because no two touch the same
//! place. A change is `[path, value]`, which puts `value` at `path`, or `[path]`, which takes
//! away what is there. A path is a list of steps from the top: a string is a key of an object,
//! and a number is a place in an array. The empty path is the whole value.
//!
//! ```json
//! [[["points", 0, 3], 2], [["phase", "remaining"], [4]], [["lastTurn"]]]
//! ```
//!
//! An array is only ever changed place by place when it keeps its length. One that grows or
//! shrinks is put back whole: that is shorter than saying where each place went. The same goes
//! for any value whose parts would take more to describe than the value itself.
//!
//! [`diff`] and [`apply`] are inverses: applying `diff(old, new)` to `old` gives `new`.
//! [`apply`] checks that every path fits the value it is applied to, so a delta applied to the
//! wrong value is more likely to be refused than to give a wrong answer.

use serde_json::Value;

/// The delta that turns `old` into `new`. Empty if they are equal.
pub fn diff(old: &Value, new: &Value) -> Value {
    let mut changes = Vec::new();
    diff_into(old, new, &mut Vec::new(), &mut changes);
    Value::Array(changes)
}

/// Adds to `changes` what turns `old` into `new`, which are both at `path`.
fn diff_into(old: &Value, new: &Value, path: &mut Vec<Value>, changes: &mut Vec<Value>) {
    if old == new {
        return;
    }
    // What changing the parts one by one takes, to compare with putting `new` there whole.
    let mut parts = Vec::new();
    match (old, new) {
        (Value::Object(old), Value::Object(new)) => {
            for (key, value) in new {
                path.push(Value::String(key.clone()));
                match old.get(key) {
                    Some(before) => diff_into(before, value, path, &mut parts),
                    None => parts.push(set(path, value)),
                }
                path.pop();
            }
            for key in old.keys().filter(|key| !new.contains_key(*key)) {
                path.push(Value::String(key.clone()));
                parts.push(Value::Array(vec![Value::Array(path.clone())]));
                path.pop();
            }
        }
        (Value::Array(old), Value::Array(new)) if old.len() == new.len() => {
            for (place, (before, after)) in old.iter().zip(new).enumerate() {
                path.push(Value::from(place));
                diff_into(before, after, path, &mut parts);
                path.pop();
            }
        }
        _ => {
            changes.push(set(path, new));
            return;
        }
    }
    let whole = set(path, new);
    if text_len(&parts) < whole.to_string().len() {
        changes.extend(parts);
    } else {
        changes.push(whole);
    }
}

/// The change that puts `value` at `path`.
fn set(path: &[Value], value: &Value) -> Value {
    Value::Array(vec![Value::Array(path.to_vec()), value.clone()])
}

/// How long `changes` are as text, with the commas between them.
fn text_len(changes: &[Value]) -> usize {
    changes
        .iter()
        .map(|change| change.to_string().len() + 1)
        .sum()
}

/// Turns `value` into what `delta` says. On an error `value` may be half way there, so a
/// caller that goes on must not use it.
pub fn apply(value: &mut Value, delta: &Value) -> Result<(), String> {
    let changes = delta.as_array().ok_or("a delta is a list of changes")?;
    changes
        .iter()
        .try_for_each(|change| apply_change(value, change))
}

fn apply_change(root: &mut Value, change: &Value) -> Result<(), String> {
    let (path, new) = match change.as_array().map(Vec::as_slice) {
        Some([path]) => (path, None),
        Some([path, new]) => (path, Some(new)),
        _ => return Err(format!("a change is [path] or [path, value], not {change}")),
    };
    let path = path
        .as_array()
        .ok_or_else(|| format!("a path is a list of steps, not {path}"))?;
    let Some((last, parents)) = path.split_last() else {
        let new = new.ok_or("the whole value can't be taken away")?;
        *root = new.clone();
        return Ok(());
    };
    let parent = parents.iter().try_fold(root, step_into)?;
    match (parent, last, new) {
        (Value::Object(object), Value::String(key), Some(new)) => {
            object.insert(key.clone(), new.clone());
            Ok(())
        }
        (Value::Object(object), Value::String(key), None) => object
            .remove(key)
            .map(|_| ())
            .ok_or_else(|| format!("there is no {key:?} to take away")),
        (Value::Array(items), Value::Number(place), Some(new)) => {
            *place_in(items, place)? = new.clone();
            Ok(())
        }
        _ => Err(format!("{change} doesn't fit what it is applied to")),
    }
}

/// What is at `step` in `at`.
fn step_into<'a>(at: &'a mut Value, step: &Value) -> Result<&'a mut Value, String> {
    match (at, step) {
        (Value::Object(object), Value::String(key)) => object
            .get_mut(key)
            .ok_or_else(|| format!("there is no {key:?} to go into")),
        (Value::Array(items), Value::Number(place)) => place_in(items, place),
        (_, step) => Err(format!("the step {step} doesn't fit what it is applied to")),
    }
}

/// The `place` in `items`, which must be one of them: an array only changes where it is.
fn place_in<'a>(
    items: &'a mut [Value],
    place: &serde_json::Number,
) -> Result<&'a mut Value, String> {
    let length = items.len();
    place
        .as_u64()
        .and_then(|place| items.get_mut(usize::try_from(place).ok()?))
        .ok_or_else(|| format!("there is no place {place} in an array of {length}"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// `diff(old, new)`, after checking that it turns `old` into `new`.
    fn checked_diff(old: &Value, new: &Value) -> Value {
        let delta = diff(old, new);
        let mut value = old.clone();
        apply(&mut value, &delta).unwrap_or_else(|err| panic!("{delta} does not apply: {err}"));
        assert_eq!(&value, new, "{delta} applied to {old}");
        delta
    }

    #[test]
    fn equal_values_have_an_empty_delta() {
        let value = json!({ "a": [1, 2, { "b": null }], "c": "d" });

        assert_eq!(checked_diff(&value, &value), json!([]));
    }

    /// A row of a long backgammon board: 24 places, mostly empty.
    fn row(places: [(usize, u8); 3]) -> Value {
        let mut row = [0; 24];
        for (place, checkers) in places {
            row[place] = checkers;
        }
        json!(row)
    }

    #[test]
    fn a_changed_place_of_an_array_is_one_short_change() {
        let old = json!({ "points": [row([(0, 8), (3, 2), (6, 1)]), row([(0, 9), (2, 2), (4, 1)])], "turn": 0 });
        let new = json!({ "points": [row([(0, 8), (3, 2), (6, 1)]), row([(0, 9), (2, 1), (4, 2)])], "turn": 0 });

        let delta = checked_diff(&old, &new);

        assert_eq!(delta, json!([[["points", 1, 2], 1], [["points", 1, 4], 2]]));
    }

    #[test]
    fn an_array_that_changes_length_is_put_back_whole() {
        let old = json!({ "played": [{ "from": 1, "die": 6 }], "turn": 0 });
        let new =
            json!({ "played": [{ "from": 1, "die": 6 }, { "from": 3, "die": 2 }], "turn": 0 });

        let delta = checked_diff(&old, &new);

        assert_eq!(
            delta,
            json!([[["played"], [{ "from": 1, "die": 6 }, { "from": 3, "die": 2 }]]])
        );
    }

    #[test]
    fn a_key_that_is_new_is_set_and_one_that_is_gone_is_taken_away() {
        let old = json!({ "keep": 1, "gone": 2, "other": [1, 2, 3, 4, 5, 6, 7, 8] });
        let new = json!({ "keep": 1, "added": 3, "other": [1, 2, 3, 4, 5, 6, 7, 8] });

        let delta = checked_diff(&old, &new);

        assert_eq!(delta, json!([[["added"], 3], [["gone"]]]));
    }

    #[test]
    fn null_is_a_value_like_any_other() {
        let object = json!({ "lastTurn": { "seat": 1, "dice": [3, 4] }, "filler": "xxxxxxxxxxxx" });
        let null = json!({ "lastTurn": null, "filler": "xxxxxxxxxxxx" });

        assert_eq!(checked_diff(&object, &null), json!([[["lastTurn"], null]]));
        assert_eq!(
            checked_diff(&null, &object),
            json!([[["lastTurn"], { "seat": 1, "dice": [3, 4] }]])
        );
    }

    #[test]
    fn a_value_that_changes_kind_is_put_back_whole() {
        // An object put where an array was must not be taken for changes to its places.
        let array = json!({ "x": [1, 2], "filler": "xxxxxxxxxxxx" });
        let object = json!({ "x": { "0": 5 }, "filler": "xxxxxxxxxxxx" });

        assert_eq!(checked_diff(&array, &object), json!([[["x"], { "0": 5 }]]));
        assert_eq!(checked_diff(&object, &array), json!([[["x"], [1, 2]]]));
        checked_diff(&json!(1), &json!("one"));
        checked_diff(&json!([1]), &json!({ "a": 1 }));
        checked_diff(&json!(null), &json!([]));
    }

    #[test]
    fn a_change_is_not_split_up_when_the_whole_is_shorter() {
        let old = json!({ "a": [1, 2, 3] });
        let new = json!({ "a": [4, 5, 6] });

        // Three changes of a place each are longer than the array.
        assert_eq!(checked_diff(&old, &new), json!([[["a"], [4, 5, 6]]]));
    }

    #[test]
    fn a_delta_is_much_shorter_than_the_state_when_a_little_changes() {
        let board = |one: u8, other: u8| json!({ "points": [row([(0, one), (3, 2), (6, 1)]), row([(0, other), (1, 1), (2, 2)])] });
        let (old, new) = (board(8, 9), board(7, 8));

        let delta = checked_diff(&old, &new);

        assert!(delta.to_string().len() * 2 < new.to_string().len());
    }

    #[test]
    fn the_empty_path_is_the_whole_value() {
        let mut value = json!({ "a": 1 });

        apply(&mut value, &json!([[[], [1, 2]]])).unwrap();

        assert_eq!(value, json!([1, 2]));
    }

    #[test]
    fn a_delta_that_does_not_fit_is_refused() {
        let value = json!({ "a": [1, 2], "b": 3 });
        for (what, delta) in [
            ("not a list", json!({})),
            ("a change that is not a list", json!([1])),
            ("a change of three parts", json!([[["b"], 1, 2]])),
            ("a path that is not a list", json!([["b", 1]])),
            ("a key that is not there", json!([[["c", "d"], 1]])),
            ("taking away a key that is not there", json!([[["c"]]])),
            ("a place beyond the array", json!([[["a", 2], 1]])),
            ("a place that is not a number", json!([[["a", -1], 1]])),
            ("a place of an object", json!([[["b", 0], 1]])),
            ("a key of an array", json!([[["a", "x"], 1]])),
            ("taking away a place of an array", json!([[["a", 0]]])),
            ("taking away the whole value", json!([[[]]])),
        ] {
            let mut copy = value.clone();
            assert!(apply(&mut copy, &delta).is_err(), "{what} was accepted");
        }
    }

    /// A small generator of values, to try [`diff`] on more than anyone would think of.
    struct Random(u64);

    impl Random {
        fn below(&mut self, n: u64) -> u64 {
            // xorshift64
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % n
        }

        fn value(&mut self, depth: u32) -> Value {
            match self.below(if depth == 0 { 4 } else { 6 }) {
                0 => Value::Null,
                1 => json!(self.below(4)),
                2 => json!(["a", "b", "c"][self.below(3) as usize]),
                3 => json!(self.below(2) == 0),
                4 => Value::Array((0..self.below(5)).map(|_| self.value(depth - 1)).collect()),
                _ => Value::Object(
                    (0..self.below(5))
                        .map(|_| (format!("k{}", self.below(5)), self.value(depth - 1)))
                        .collect(),
                ),
            }
        }

        /// `value` with a few parts replaced.
        fn changed(&mut self, value: &Value, depth: u32) -> Value {
            match value {
                _ if self.below(6) == 0 => self.value(depth),
                Value::Array(items) => {
                    Value::Array(items.iter().map(|item| self.changed(item, depth)).collect())
                }
                Value::Object(object) => {
                    let mut changed = serde_json::Map::new();
                    for (key, item) in object {
                        if self.below(8) != 0 {
                            changed.insert(key.clone(), self.changed(item, depth));
                        }
                    }
                    Value::Object(changed)
                }
                other => other.clone(),
            }
        }
    }

    #[test]
    fn applying_a_diff_gives_the_new_value_for_any_values() {
        let mut random = Random(0x9e37_79b9_7f4a_7c15);
        for _ in 0..5_000 {
            let old = random.value(4);
            let new = if random.below(4) == 0 {
                random.value(4)
            } else {
                random.changed(&old, 2)
            };
            checked_diff(&old, &new);
        }
    }
}
