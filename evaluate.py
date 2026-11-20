"""Run python evaluate.py to compare all policies over the full dataset."""
import json

from simulation import DATES, compare

# Run the evaluation when this file is executed directly.
if __name__ == "__main__":
    # Compare all allocation policies across the full dataset
    # and display the results in a readable JSON format.
    print(json.dumps(compare(DATES), indent=2))
