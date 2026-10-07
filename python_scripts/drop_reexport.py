#!/usr/bin/env python3
"""Remove rows where flow_desc is Re-import or Re-export."""

import argparse
import csv

DROP_VALUES = {"Re-import", "Re-export"}


def main():
    parser = argparse.ArgumentParser(description="Drop Re-import/Re-export rows from a CSV.")
    parser.add_argument("input_csv", help="Path to the CSV file to edit.")
    parser.add_argument("output_csv", help="Path to write the resulting CSV to.")
    args = parser.parse_args()

    with open(args.input_csv, newline="") as infile:
        reader = csv.DictReader(infile)
        fieldnames = reader.fieldnames
        rows = [row for row in reader if row["flow_desc"] not in DROP_VALUES]

    with open(args.output_csv, "w", newline="") as outfile:
        writer = csv.DictWriter(outfile, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
